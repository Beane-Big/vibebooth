package main

import (
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func (s *Server) mountRegistration(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/platform/auth/options", func(w http.ResponseWriter, r *http.Request) {
		info, err := s.currentSite(r.Context())
		if err != nil {
			internalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"terms":             info.Terms,
			"privacy":           info.Privacy,
			"allowRegistration": info.AllowRegistration,
		})
	})

	attempts := newLoginLimiter(8, 15*time.Minute)
	mux.HandleFunc("POST /api/platform/auth/register", func(w http.ResponseWriter, r *http.Request) {
		info, err := s.currentSite(r.Context())
		if err != nil {
			internalError(w, err)
			return
		}
		if !info.AllowRegistration {
			writeError(w, http.StatusForbidden, "当前未开放自助注册")
			return
		}
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
		tx, err := s.store.pool.Begin(r.Context())
		if err != nil {
			internalError(w, err)
			return
		}
		defer tx.Rollback(r.Context())
		var personID int64
		if err := tx.QueryRow(r.Context(), `INSERT INTO persons (name) VALUES ($1) RETURNING id`, username).Scan(&personID); err != nil {
			internalError(w, err)
			return
		}
		tag, err := tx.Exec(r.Context(), `INSERT INTO users (username, email, display_name, password_hash, roles, self_registered, person_id)
			SELECT $1, NULLIF($2, ''), $1, $3, '{}', true, $4
			WHERE $2 = '' OR NOT EXISTS (SELECT 1 FROM users WHERE lower(username) = $2)
			ON CONFLICT DO NOTHING`, username, email, string(hash), personID)
		if err != nil {
			internalError(w, err)
			return
		}
		if tag.RowsAffected() == 0 {
			writeError(w, http.StatusConflict, "无法使用此账号或邮箱注册，请更换后重试。")
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			internalError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func validAuthPassword(password string) bool {
	return len([]rune(password)) >= 8 && len(password) <= 72
}
