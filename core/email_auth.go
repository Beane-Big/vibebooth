package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

func normalizeEmail(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) > 254 {
		return ""
	}
	addr, err := mail.ParseAddress(value)
	if err != nil || addr.Address != value {
		return ""
	}
	for _, c := range value {
		if c < 33 || c > 126 {
			return ""
		}
	}
	return value
}

func policyURL(key string) string {
	value := strings.TrimSpace(os.Getenv(key))
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return ""
	}
	return value
}

type authMailer struct {
	addr, host, from, username, password string
}

func (m authMailer) send(to, code string) error {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", m.addr, &tls.Config{ServerName: m.host, MinVersion: tls.VersionTLS12})
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	client, err := smtp.NewClient(conn, m.host)
	if err != nil {
		return err
	}
	defer client.Close()
	if m.username != "" {
		if err := client.Auth(smtp.PlainAuth("", m.username, m.password, m.host)); err != nil {
			return err
		}
	}
	if err := client.Mail(m.from); err != nil {
		return err
	}
	if err := client.Rcpt(to); err != nil {
		return err
	}
	body, err := client.Data()
	if err != nil {
		return err
	}
	subject := mime.QEncoding.Encode("UTF-8", "Vibebooth 邮箱验证码")
	if _, err := fmt.Fprintf(body, "From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=US-ASCII\r\n\r\nVibebooth verification code: %s\r\nExpires in 15 minutes.\r\n", m.from, to, subject, code); err != nil {
		return err
	}
	return body.Close()
}

func (s *Server) mountEmailAuth(mux *http.ServeMux) {
	addr := strings.TrimSpace(os.Getenv("SMTP_TLS_ADDR"))
	host, _, _ := net.SplitHostPort(addr)
	mailer := authMailer{addr: addr, host: host, from: normalizeEmail(os.Getenv("SMTP_FROM")), username: os.Getenv("SMTP_USERNAME"), password: os.Getenv("SMTP_PASSWORD")}
	terms, privacy := policyURL("AUTH_TERMS_URL"), policyURL("AUTH_PRIVACY_URL")
	reset := host != "" && mailer.from != ""
	register := reset && os.Getenv("EMAIL_REGISTRATION") == "true" && terms != "" && privacy != ""
	mux.HandleFunc("GET /api/platform/auth/options", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"register": register, "reset": reset, "terms": terms, "privacy": privacy})
	})
	requests := newLoginLimiter(8, 15*time.Minute)
	submissions := newLoginLimiter(25, 15*time.Minute)
	mailSlots := make(chan struct{}, 8)
	for _, purpose := range []string{"register", "reset"} {
		enabled := reset
		if purpose == "register" {
			enabled = register
		}
		mux.HandleFunc("POST /api/platform/auth/"+purpose+"/code", func(w http.ResponseWriter, r *http.Request) {
			if !enabled {
				writeError(w, http.StatusServiceUnavailable, "此功能暂未启用")
				return
			}
			ip := clientIP(r)
			if !requests.Allow(ip) {
				writeError(w, http.StatusTooManyRequests, "操作过于频繁，请稍后再试")
				return
			}
			requests.Fail(ip)
			var in struct {
				Email string `json:"email"`
			}
			if !decodeJSON(w, r, &in) {
				return
			}
			email := normalizeEmail(in.Email)
			if email == "" {
				writeError(w, http.StatusBadRequest, "请输入有效的邮箱地址")
				return
			}
			// 请求响应只表示已受理，不依赖账号状态或投递容量。
			select {
			case mailSlots <- struct{}{}:
				go func() {
					defer func() { <-mailSlots }()
					s.issueEmailCode(mailer, purpose, email)
				}()
			default:
				slog.Warn("验证邮件派发已满", "purpose", purpose)
			}
			w.WriteHeader(http.StatusNoContent)
		})
		mux.HandleFunc("POST /api/platform/auth/"+purpose+"/verify", func(w http.ResponseWriter, r *http.Request) {
			if !enabled {
				writeError(w, http.StatusServiceUnavailable, "此功能暂未启用")
				return
			}
			ip := clientIP(r)
			if !submissions.Allow(ip) {
				writeError(w, http.StatusTooManyRequests, "操作过于频繁，请稍后再试")
				return
			}
			submissions.Fail(ip)
			var in struct {
				Email string `json:"email"`
				Code  string `json:"code"`
			}
			if !decodeJSON(w, r, &in) {
				return
			}
			var valid bool
			err := s.store.pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM email_auth_codes
    WHERE purpose=$1 AND email=$2 AND digest=$3 AND issued_at > now()-interval '15 minutes')`,
				purpose, normalizeEmail(in.Email), hashToken([]byte(strings.ToLower(strings.TrimSpace(in.Code))))).Scan(&valid)
			if err != nil {
				internalError(w, err)
				return
			}
			if !valid {
				writeError(w, http.StatusBadRequest, "验证码无效或已过期，请重新获取")
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
		mux.HandleFunc("POST /api/platform/auth/"+purpose, func(w http.ResponseWriter, r *http.Request) {
			if !enabled {
				writeError(w, http.StatusServiceUnavailable, "此功能暂未启用")
				return
			}
			ip := clientIP(r)
			if !submissions.Allow(ip) {
				writeError(w, http.StatusTooManyRequests, "操作过于频繁，请稍后再试")
				return
			}
			submissions.Fail(ip)
			var in struct {
				Email       string `json:"email"`
				Code        string `json:"code"`
				Password    string `json:"password"`
				DisplayName string `json:"displayName"`
				Accepted    bool   `json:"accepted"`
			}
			if !decodeJSON(w, r, &in) {
				return
			}
			email := normalizeEmail(in.Email)
			code := strings.ToLower(strings.TrimSpace(in.Code))
			name := strings.TrimSpace(in.DisplayName)
			if email == "" || len(code) != 12 {
				writeError(w, http.StatusBadRequest, "请检查邮箱与验证码")
				return
			}
			if len([]rune(in.Password)) < 8 || len(in.Password) > 72 {
				writeError(w, http.StatusBadRequest, "密码至少 8 个字符，且不能超过 72 字节")
				return
			}
			if purpose == "register" && (!validDisplayName(name) || !in.Accepted) {
				writeError(w, http.StatusBadRequest, "请填写显示名称并同意服务条款与隐私声明")
				return
			}
			ctx := r.Context()
			tx, err := s.store.pool.Begin(ctx)
			if err != nil {
				internalError(w, err)
				return
			}
			defer tx.Rollback(ctx)
			var found int
			err = tx.QueryRow(ctx, `DELETE FROM email_auth_codes WHERE purpose=$1 AND email=$2 AND digest=$3
    AND issued_at > now()-interval '15 minutes' RETURNING 1`, purpose, email, hashToken([]byte(code))).Scan(&found)
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusBadRequest, "验证码无效或已过期，请重新获取")
				return
			}
			if err != nil {
				internalError(w, err)
				return
			}
			hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
			if err != nil {
				internalError(w, err)
				return
			}
			if purpose == "register" {
				_, err = tx.Exec(ctx, `INSERT INTO users(username,display_name,password_hash,roles,email_verified)
     VALUES($1,$2,$3,'{}',true) ON CONFLICT(username) DO NOTHING`, email, name, string(hash))
			} else {
				var id int64
				err = tx.QueryRow(ctx, `UPDATE users SET password_hash=$2 WHERE username=$1 AND email_verified AND NOT disabled RETURNING id`, email, string(hash)).Scan(&id)
				if errors.Is(err, pgx.ErrNoRows) {
					writeError(w, http.StatusBadRequest, "验证码无效或已过期，请重新获取")
					return
				}
				if err == nil {
					_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id=$1`, id)
				}
			}
			if err != nil {
				internalError(w, err)
				return
			}
			if err := tx.Commit(ctx); err != nil {
				internalError(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}
}

func (s *Server) issueEmailCode(mailer authMailer, purpose, email string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var eligible bool
	err := s.store.pool.QueryRow(ctx, `SELECT CASE WHEN $2 = 'register'
		THEN NOT EXISTS(SELECT 1 FROM users WHERE username = $1)
		ELSE EXISTS(SELECT 1 FROM users WHERE username = $1 AND email_verified AND NOT disabled)
		END`, email, purpose).Scan(&eligible)
	if err != nil {
		slog.Warn("检查验证邮件发送条件失败", "purpose", purpose, "err", err)
		return
	}
	if !eligible {
		return
	}

	var random [6]byte
	if _, err := rand.Read(random[:]); err != nil {
		slog.Warn("生成邮箱验证码失败", "purpose", purpose, "err", err)
		return
	}
	code := hex.EncodeToString(random[:])
	tag, err := s.store.pool.Exec(ctx, `
		INSERT INTO email_auth_codes (purpose, email, digest) VALUES ($1, $2, $3)
		ON CONFLICT (purpose, email) DO UPDATE SET digest = excluded.digest, issued_at = now()
		WHERE email_auth_codes.issued_at < now() - interval '1 minute'`, purpose, email, hashToken([]byte(code)))
	if err != nil {
		slog.Warn("保存邮箱验证码失败", "purpose", purpose, "err", err)
		return
	}
	if tag.RowsAffected() > 0 && mailer.send(email, code) != nil {
		slog.Warn("发送登录验证邮件失败", "purpose", purpose)
	}
}
