package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"
)

const googleFlowCookie = "__Host-vb_google_flow"

func googleOAuthConfig() (oauth2.Config, bool) {
	cfg := oauth2.Config{
		ClientID:     strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID")),
		ClientSecret: strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_SECRET")),
		RedirectURL:  strings.TrimSpace(os.Getenv("GOOGLE_REDIRECT_URL")),
		Endpoint: oauth2.Endpoint{
			AuthURL:   "https://accounts.google.com/o/oauth2/v2/auth",
			TokenURL:  "https://oauth2.googleapis.com/token",
			AuthStyle: oauth2.AuthStyleInParams,
		},
		Scopes: []string{oidc.ScopeOpenID, "email"},
	}
	u, err := url.Parse(cfg.RedirectURL)
	return cfg, cfg.ClientID != "" && cfg.ClientSecret != "" && err == nil &&
		u.Scheme == "https" && u.Hostname() != "" && u.User == nil &&
		u.Path == "/api/platform/auth/google/callback" && u.RawQuery == "" && u.Fragment == ""
}

func (s *Server) mountGoogleAuth(mux *http.ServeMux, cfg oauth2.Config) {
	verifier := oidc.NewVerifier("https://accounts.google.com",
		oidc.NewRemoteKeySet(oidc.ClientContext(context.Background(), &http.Client{Timeout: 8 * time.Second}), "https://www.googleapis.com/oauth2/v3/certs"),
		&oidc.Config{ClientID: cfg.ClientID})
	mux.HandleFunc("GET /api/platform/auth/google", func(w http.ResponseWriter, r *http.Request) {
		var bytes [32]byte
		if _, err := rand.Read(bytes[:]); err != nil {
			internalError(w, err)
			return
		}
		state := base64.RawURLEncoding.EncodeToString(bytes[:])
		challenge := oauth2.GenerateVerifier()
		http.SetCookie(w, &http.Cookie{Name: googleFlowCookie, Value: state + "." + challenge, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 300})
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, cfg.AuthCodeURL(state, oauth2.S256ChallengeOption(challenge), oauth2.SetAuthURLParam("nonce", state), oauth2.SetAuthURLParam("prompt", "select_account")), http.StatusSeeOther)
	})
	mux.HandleFunc("GET /api/platform/auth/google/callback", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		fail := func() { http.Redirect(w, r, "/login?google_error=1", http.StatusSeeOther) }
		cookie, err := r.Cookie(googleFlowCookie)
		if err != nil {
			fail()
			return
		}
		state, challenge, ok := strings.Cut(cookie.Value, ".")
		params := r.URL.Query()
		if !ok || state == "" || challenge == "" || subtle.ConstantTimeCompare([]byte(state), []byte(params.Get("state"))) != 1 {
			fail()
			return
		}
		http.SetCookie(w, &http.Cookie{Name: googleFlowCookie, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
		code := params.Get("code")
		if code == "" {
			fail()
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		ctx = context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Timeout: 8 * time.Second})
		token, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(challenge))
		if err != nil {
			fail()
			return
		}
		raw, ok := token.Extra("id_token").(string)
		if !ok {
			fail()
			return
		}
		id, err := verifier.Verify(ctx, raw)
		if err != nil || id.Nonce != state || id.Subject == "" {
			fail()
			return
		}
		var claims struct {
			Email    string `json:"email"`
			Verified bool   `json:"email_verified"`
		}
		if id.Claims(&claims) != nil || !claims.Verified {
			fail()
			return
		}
		email := normalizeEmail(claims.Email)
		// 只按 Gmail 地址首次关联，Google 对外部邮箱的历史验证不能证明当前控制权。
		if !strings.HasSuffix(email, "@gmail.com") {
			fail()
			return
		}
		var userID int64
		var passwordHash string
		err = s.store.pool.QueryRow(ctx, `
    UPDATE users SET google_subject = $2
    WHERE username = $1 AND email_verified AND NOT disabled
      AND (google_subject IS NULL OR google_subject = $2)
    RETURNING id, password_hash`, email, id.Subject).Scan(&userID, &passwordHash)
		if err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				slog.Warn("关联 Google 账号失败")
			}
			fail()
			return
		}
		var session [32]byte
		if _, err := rand.Read(session[:]); err != nil {
			internalError(w, err)
			return
		}
		now := time.Now()
		created, err := s.store.CreateSession(ctx, hashToken(session[:]), userID, passwordHash, now.Add(sessionIdle))
		if err != nil {
			internalError(w, err)
			return
		}
		if !created {
			fail()
			return
		}
		s.recordLogin(ctx, email, true)
		s.setLoginCookie(w, session[:], time.Time{})
		http.Redirect(w, r, "/", http.StatusSeeOther)
	})
}
