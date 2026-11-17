package main

import (
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func (s *Server) mountRegistration(mux *http.ServeMux) {
	terms, privacy := policyURL("AUTH_TERMS_URL"), policyURL("AUTH_PRIVACY_URL")
	mux.HandleFunc("GET /api/platform/auth/options", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"terms": terms, "privacy": privacy})
	})

	attempts := newLoginLimiter(8, 15*time.Minute)
	mux.HandleFunc("POST /api/platform/auth/register", func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if !attempts.Allow(ip) {
			writeError(w, http.StatusTooManyRequests, "操作过于频繁，请稍后再试")
			return
		}
		attempts.Fail(ip)
		var in struct {
			Username string `json:"username"`
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if !decodeJSON(w, r, &in) {
			return
		}
		username := strings.TrimSpace(in.Username)
		if !usernamePattern.MatchString(username) {
			writeError(w, http.StatusBadRequest, "账号须为 2–32 位字母、数字、下划线、点或连字符")
			return
		}
		rawEmail := strings.TrimSpace(in.Email)
		email := normalizeEmail(rawEmail)
		if rawEmail != "" && email == "" {
			writeError(w, http.StatusBadRequest, "请输入有效的邮箱地址")
			return
		}
		if !validAuthPassword(in.Password) {
			writeError(w, http.StatusBadRequest, "密码至少 8 个字符，且不能超过 72 字节")
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
		if err != nil {
			internalError(w, err)
			return
		}
		tag, err := s.store.pool.Exec(r.Context(), `INSERT INTO users (username, email, display_name, password_hash, roles, self_registered)
			SELECT $1, NULLIF($2, ''), '', $3, '{}', true
			WHERE $2 = '' OR NOT EXISTS (SELECT 1 FROM users WHERE lower(username) = $2)
			ON CONFLICT DO NOTHING`, username, email, string(hash))
		if err != nil {
			internalError(w, err)
			return
		}
		if tag.RowsAffected() == 0 {
			writeError(w, http.StatusConflict, "无法使用此账号或邮箱注册，请更换后重试。")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func validAuthPassword(password string) bool {
	return len([]rune(password)) >= 8 && len(password) <= 72
}
