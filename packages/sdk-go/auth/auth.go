// Package auth 供模块后端校验网关注入的用户令牌。
//
// 网关在请求通过登录校验后，会在 Authorization 头里放一个由平台核心签发的短期 JWT。
// 模块不应只信任请求头本身，而要用平台公钥验签，并确认令牌是发给自己的（aud）。
package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const issuer = "home-platform"

// User 是令牌里携带的当前用户信息。
type User struct {
	ID    string   `json:"sub"`
	Name  string   `json:"name"`
	Roles []string `json:"roles"`
}

type claims struct {
	Name  string   `json:"name"`
	Roles []string `json:"roles"`
	jwt.RegisteredClaims
}

// Verifier 从平台的 JWKS 地址获取公钥并校验令牌。
type Verifier struct {
	jwksURL  string
	moduleID string
	client   *http.Client

	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
}

// NewVerifier 中 jwksURL 一般是 http://core:8080/api/platform/.well-known/jwks.json，
// moduleID 是本模块在 module.yaml 里的 id。
func NewVerifier(jwksURL, moduleID string) *Verifier {
	return &Verifier{
		jwksURL:  jwksURL,
		moduleID: moduleID,
		client:   &http.Client{Timeout: 5 * time.Second},
		keys:     map[string]*rsa.PublicKey{},
	}
}

// Verify 校验 "Bearer xxx" 形式的令牌，返回其中的用户。
func (v *Verifier) Verify(ctx context.Context, authorization string) (*User, error) {
	raw, ok := strings.CutPrefix(authorization, "Bearer ")
	if !ok {
		return nil, errors.New("缺少令牌")
	}
	var c claims
	_, err := jwt.ParseWithClaims(raw, &c, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		return v.key(ctx, kid)
	},
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(issuer),
		jwt.WithAudience(v.moduleID),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, err
	}
	return &User{ID: c.Subject, Name: c.Name, Roles: c.Roles}, nil
}

// Middleware 拦截未通过校验的请求；通过后可用 UserFrom 取当前用户。
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := v.Verify(r.Context(), r.Header.Get("Authorization"))
		if err != nil {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": "令牌无效"})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey{}, user)))
	})
}

type userKey struct{}

// UserFrom 返回 Middleware 放入请求上下文的用户。
func UserFrom(ctx context.Context) *User {
	u, _ := ctx.Value(userKey{}).(*User)
	return u
}

// key 按 kid 取公钥；遇到未知 kid 时重新拉取 JWKS，但 30 秒内最多拉一次。
func (v *Verifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if k, ok := v.keys[kid]; ok {
		return k, nil
	}
	if time.Since(v.fetchedAt) < 30*time.Second {
		return nil, fmt.Errorf("未知的签名密钥 %q", kid)
	}
	v.fetchedAt = time.Now()
	keys, err := v.fetch(ctx)
	if err != nil {
		return nil, err
	}
	v.keys = keys
	if k, ok := keys[kid]; ok {
		return k, nil
	}
	return nil, fmt.Errorf("未知的签名密钥 %q", kid)
}

func (v *Verifier) fetch(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := v.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("获取 JWKS 失败: %s", resp.Status)
	}
	var body struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range body.Keys {
		if k.Kty != "RSA" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	return keys, nil
}
