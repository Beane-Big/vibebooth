package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	sessionCookie = "hp_session"
	// 会话 7 天不用就过期，在用就自动续期；但从登录算起最长 30 天，到期必须重新登录。
	sessionIdle   = 7 * 24 * time.Hour
	sessionMaxAge = 30 * 24 * time.Hour
	tokenTTL      = 5 * time.Minute
	tokenIssuer   = "home-platform"
)

type Server struct {
	cfg      config
	store    *Store
	key      *signingKey
	registry *Registry
	limiter  *loginLimiter
}

// ---- 登录与会话 ----

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !s.limiter.Allow(ip) {
		writeError(w, http.StatusTooManyRequests, "登录失败次数过多，请稍后再试")
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	user, err := s.store.CheckPassword(r.Context(), strings.TrimSpace(req.Username), req.Password)
	if err != nil {
		internalError(w, err)
		return
	}
	if user == nil {
		s.limiter.Fail(ip)
		writeError(w, http.StatusUnauthorized, "用户名或密码错误")
		return
	}
	s.limiter.Reset(ip)

	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		internalError(w, err)
		return
	}
	now := time.Now()
	if err := s.store.CreateSession(r.Context(), hashToken(token), user.ID, now.Add(sessionIdle)); err != nil {
		internalError(w, err)
		return
	}
	// Cookie 按最长期限保留，7 天不用就过期由数据库里的会话判断。
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    base64.RawURLEncoding.EncodeToString(token),
		Path:     "/",
		Expires:  now.Add(sessionMaxAge),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if hash, ok := sessionHash(r); ok {
		if err := s.store.DeleteSession(r.Context(), hash); err != nil {
			internalError(w, err)
			return
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMe(w http.ResponseWriter, _ *http.Request, user *User) {
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) currentUser(r *http.Request) (*User, error) {
	hash, ok := sessionHash(r)
	if !ok {
		return nil, nil
	}
	return s.store.UserBySession(r.Context(), hash)
}

func (s *Server) requireUser(next func(http.ResponseWriter, *http.Request, *User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, err := s.currentUser(r)
		if err != nil {
			internalError(w, err)
			return
		}
		if user == nil {
			writeError(w, http.StatusUnauthorized, "未登录")
			return
		}
		next(w, r, user)
	}
}

func (s *Server) requireRole(role string, next func(http.ResponseWriter, *http.Request, *User)) http.HandlerFunc {
	return s.requireUser(func(w http.ResponseWriter, r *http.Request, user *User) {
		if !hasAnyRole(user.Roles, []string{role}) {
			writeError(w, http.StatusForbidden, "没有权限")
			return
		}
		next(w, r, user)
	})
}

// renewedExpiry 算出在用的会话该续到什么时候：剩余时间不到一半时延长到 idle 之后，
// 但不超过登录后 maxAge。不需要续期时返回 false，免得网关每次校验都写数据库。
func renewedExpiry(now, created, expires time.Time) (time.Time, bool) {
	if expires.Sub(now) >= sessionIdle/2 {
		return expires, false
	}
	next := now.Add(sessionIdle)
	if limit := created.Add(sessionMaxAge); next.After(limit) {
		next = limit
	}
	return next, next.After(expires)
}

func (s *Server) cleanupSessions(ctx context.Context) {
	for {
		if err := s.store.DeleteExpiredSessions(ctx); err != nil {
			slog.Warn("清理过期会话失败", "err", err)
		}
		time.Sleep(time.Hour)
	}
}

// ---- 网关 forwardAuth ----

// handleVerify 由 Traefik 在把请求转给模块之前调用。
// 返回 2xx 时，Traefik 把这里设置的 Authorization 等头带给模块；其他状态码原样返回给浏览器。
func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	uri := r.Header.Get("X-Forwarded-Uri")
	isAPI := strings.HasPrefix(uri, "/api/")

	user, err := s.currentUser(r)
	if err != nil {
		internalError(w, err)
		return
	}
	if user == nil {
		if isAPI {
			writeError(w, http.StatusUnauthorized, "未登录")
			return
		}
		// Traefik 会把相对地址解析成平台核心自己的内部地址，所以这里拼出浏览器访问的完整地址。
		loginURL := forwardedOrigin(r) + "/login?next=" + url.QueryEscape(uri)
		http.Redirect(w, r, loginURL, http.StatusFound)
		return
	}

	path, _, _ := strings.Cut(uri, "?")
	app, ok := s.registry.Get(appIDFromURI(path))
	if !ok {
		writeError(w, http.StatusNotFound, "应用不存在")
		return
	}
	g, err := s.store.Grants(r.Context(), user.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	menus := menusFor(user, app, g)
	if len(menus) == 0 {
		writeError(w, http.StatusForbidden, "没有访问这个应用的权限")
		return
	}
	// 接口的细粒度权限由模块后端用令牌里的 menus 判断；这里只拦页面。
	if !isAPI && !canOpenPage(app, menus, path) {
		writeError(w, http.StatusForbidden, "没有访问这个页面的权限")
		return
	}

	token, err := s.issueToken(user, app.ID, menuIDs(menus))
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Authorization", "Bearer "+token)
	w.Header().Set("X-User-Id", strconv.FormatInt(user.ID, 10))
	w.Header().Set("X-User-Roles", strings.Join(user.Roles, ","))
	w.WriteHeader(http.StatusOK)
}

// handleVerifyAdmin 给平台自己的管理接口（目前是安装器 /api/platform/installer/）做登录校验：只放行管理员。
// 通过时附上一个只能用于安装器的令牌，安装器再用公钥验签。
func (s *Server) handleVerifyAdmin(w http.ResponseWriter, r *http.Request) {
	user, err := s.currentUser(r)
	if err != nil {
		internalError(w, err)
		return
	}
	if user == nil {
		writeError(w, http.StatusUnauthorized, "未登录")
		return
	}
	if !user.IsAdmin() {
		writeError(w, http.StatusForbidden, "只有管理员能管理应用")
		return
	}
	token, err := s.issueToken(user, "installer", nil)
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Authorization", "Bearer "+token)
	w.WriteHeader(http.StatusOK)
}

// appIDFromURI 从 /apps/{id}/... 或 /api/{id}/... 中取出模块 id。
func appIDFromURI(uri string) string {
	path := uri
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	parts := strings.SplitN(strings.TrimPrefix(path, "/"), "/", 3)
	if len(parts) < 2 || (parts[0] != "apps" && parts[0] != "api") {
		return ""
	}
	return parts[1]
}

// forwardedOrigin 返回浏览器看到的协议和主机，如 http://192.168.1.10:8080。
func forwardedOrigin(r *http.Request) string {
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto != "https" {
		proto = "http"
	}
	return proto + "://" + r.Header.Get("X-Forwarded-Host")
}

func hasAnyRole(have, want []string) bool {
	for _, w := range want {
		for _, h := range have {
			if h == w {
				return true
			}
		}
	}
	return false
}

// ---- 模块令牌（RS256 JWT）----

type signingKey struct {
	private *rsa.PrivateKey
	kid     string
}

func loadOrCreateKey(path string) (*signingKey, error) {
	var priv *rsa.PrivateKey
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		block, _ := pem.Decode(data)
		if block == nil {
			return nil, errors.New("密钥文件格式错误: " + path)
		}
		priv, err = x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
	case errors.Is(err, os.ErrNotExist):
		priv, err = rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
		pemBytes := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})
		if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
			return nil, err
		}
		slog.Info("已生成新的签名密钥", "path", path)
	default:
		return nil, err
	}
	pub := x509.MarshalPKCS1PublicKey(&priv.PublicKey)
	sum := sha256.Sum256(pub)
	return &signingKey{private: priv, kid: base64.RawURLEncoding.EncodeToString(sum[:8])}, nil
}

// issueToken 签发给某个模块用的令牌，menus 是这个人在该模块里有权限的菜单。
func (s *Server) issueToken(user *User, audience string, menus []string) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"iss":   tokenIssuer,
		"sub":   strconv.FormatInt(user.ID, 10),
		"aud":   audience,
		"iat":   now.Unix(),
		"exp":   now.Add(tokenTTL).Unix(),
		"name":  user.DisplayName,
		"roles": user.Roles,
		"menus": menus,
	}
	t := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	t.Header["kid"] = s.key.kid
	return t.SignedString(s.key.private)
}

func (s *Server) handleJWKS(w http.ResponseWriter, _ *http.Request) {
	pub := s.key.private.PublicKey
	writeJSON(w, http.StatusOK, map[string]any{
		"keys": []map[string]string{{
			"kty": "RSA",
			"use": "sig",
			"alg": "RS256",
			"kid": s.key.kid,
			"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
		}},
	})
}

// ---- 登录限流 ----

type loginLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	fails  map[string][]time.Time
}

func newLoginLimiter(max int, window time.Duration) *loginLimiter {
	return &loginLimiter{max: max, window: window, fails: map[string][]time.Time{}}
}

func (l *loginLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := time.Now().Add(-l.window)
	recent := l.fails[ip][:0]
	for _, t := range l.fails[ip] {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	if len(recent) == 0 {
		delete(l.fails, ip)
	} else {
		l.fails[ip] = recent
	}
	return len(recent) < l.max
}

func (l *loginLimiter) Fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.fails[ip] = append(l.fails[ip], time.Now())
}

func (l *loginLimiter) Reset(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.fails, ip)
}

// ---- 工具函数 ----

func sessionHash(r *http.Request) ([]byte, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil, false
	}
	token, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil || len(token) != 32 {
		return nil, false
	}
	return hashToken(token), true
}

func hashToken(token []byte) []byte {
	sum := sha256.Sum256(token)
	return sum[:]
}

// clientIP 取网关写入的真实客户端地址；核心服务只在内部网络可达，所以可以信任这个头。
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-Ip"); ip != "" {
		return ip
	}
	return r.RemoteAddr
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func internalError(w http.ResponseWriter, err error) {
	slog.Error("内部错误", "err", err)
	writeError(w, http.StatusInternalServerError, "服务器内部错误")
}
