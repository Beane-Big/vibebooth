package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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
	for _, purpose := range []string{"register", "reset"} {
		for _, suffix := range []string{"", "/code", "/verify"} {
			resp := httptest.NewRecorder()
			mux.ServeHTTP(resp, httptest.NewRequest("POST", "/api/platform/auth/"+purpose+suffix, nil))
			if resp.Code != http.StatusServiceUnavailable {
				t.Errorf("%s%s: got %d, want %d", purpose, suffix, resp.Code, http.StatusServiceUnavailable)
			}
		}
	}
	resp := httptest.NewRecorder()
	mux.ServeHTTP(resp, httptest.NewRequest("GET", "/api/platform/auth/options", nil))
	if resp.Code != http.StatusOK || !strings.Contains(resp.Body.String(), `"register":false`) || !strings.Contains(resp.Body.String(), `"reset":false`) {
		t.Fatalf("unexpected public options: %d %s", resp.Code, resp.Body.String())
	}
}
