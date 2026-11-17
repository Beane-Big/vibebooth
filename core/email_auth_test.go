package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRegistrationAndGoogleCanBeEnabledWithoutSMTP(t *testing.T) {
	t.Setenv("SMTP_TLS_ADDR", "")
	t.Setenv("SMTP_FROM", "")
	t.Setenv("EMAIL_REGISTRATION", "true")
	t.Setenv("AUTH_TERMS_URL", "https://example.org/terms")
	t.Setenv("AUTH_PRIVACY_URL", "https://example.org/privacy")
	t.Setenv("GOOGLE_CLIENT_ID", "test-client")
	t.Setenv("GOOGLE_CLIENT_SECRET", "test-secret")
	t.Setenv("GOOGLE_REDIRECT_URL", "https://example.org/api/platform/auth/google/callback")
	s := &Server{}
	s.cfg.CookieSecure = true
	mux := http.NewServeMux()
	s.mountEmailAuth(mux)
	resp := httptest.NewRecorder()
	mux.ServeHTTP(resp, httptest.NewRequest("GET", "/api/platform/auth/options", nil))
	for _, flag := range []string{`"register":true`, `"reset":false`, `"google":true`} {
		if resp.Code != http.StatusOK || !strings.Contains(resp.Body.String(), flag) {
			t.Fatalf("missing %s in public options: %d %s", flag, resp.Code, resp.Body.String())
		}
	}

	// Old signup verification routes must no longer enqueue mail.
	for _, endpoint := range []string{"/code", "/verify"} {
		resp := httptest.NewRecorder()
		mux.ServeHTTP(resp, httptest.NewRequest("POST", "/api/platform/auth/register"+endpoint, nil))
		if resp.Code != http.StatusNotFound {
			t.Errorf("obsolete signup endpoint %s returned %d", endpoint, resp.Code)
		}
	}
}

func TestNormalizeEmail(t *testing.T) {
	for input, want := range map[string]string{
		"  User@Example.com ":                 "user@example.com",
		"Name <user@example.com>":             "",
		"user@example.com\nother@example.com": "",
		"legacy-user":                         "",
	} {
		if got := normalizeEmail(input); got != want {
			t.Errorf("normalizeEmail(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestEmailAuthDisabledByDefault(t *testing.T) {
	for _, key := range []string{"SMTP_TLS_ADDR", "SMTP_FROM", "EMAIL_REGISTRATION", "AUTH_TERMS_URL", "AUTH_PRIVACY_URL"} {
		t.Setenv(key, "")
	}
	mux := http.NewServeMux()
	(&Server{}).mountEmailAuth(mux)
	for _, route := range []string{"register", "reset", "reset/code", "reset/verify"} {
		resp := httptest.NewRecorder()
		mux.ServeHTTP(resp, httptest.NewRequest("POST", "/api/platform/auth/"+route, nil))
		if resp.Code != http.StatusServiceUnavailable {
			t.Errorf("%s: got %d, want %d", route, resp.Code, http.StatusServiceUnavailable)
		}
	}
	resp := httptest.NewRecorder()
	mux.ServeHTTP(resp, httptest.NewRequest("GET", "/api/platform/auth/options", nil))
	if resp.Code != http.StatusOK || !strings.Contains(resp.Body.String(), `"register":false`) || !strings.Contains(resp.Body.String(), `"reset":false`) {
		t.Fatalf("unexpected public options: %d %s", resp.Code, resp.Body.String())
	}
}
