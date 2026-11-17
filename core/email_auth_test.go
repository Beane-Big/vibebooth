package main

import (
	"net/http"
	"net/http/httptest"
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

func TestRegistrationDoesNotRequireDeploymentOptions(t *testing.T) {
	for _, key := range []string{"EMAIL_REGISTRATION", "AUTH_TERMS_URL", "AUTH_PRIVACY_URL"} {
		t.Setenv(key, "")
	}
	mux := (&Server{}).routes()
	for _, route := range []string{"/register", "/register/code", "/reset/code"} {
		resp := httptest.NewRecorder()
		mux.ServeHTTP(resp, httptest.NewRequest("POST", "/api/platform/auth"+route, nil))
		want := http.StatusNotFound
		if route == "/register" {
			want = http.StatusBadRequest // The route is enabled and validates the body.
		}
		if resp.Code != want {
			t.Errorf("%s returned %d, want %d", route, resp.Code, want)
		}
	}
	resp := httptest.NewRecorder()
	mux.ServeHTTP(resp, httptest.NewRequest("GET", "/api/platform/auth/google", nil))
	if resp.Code != http.StatusNotFound {
		t.Errorf("Google sign-in returned %d", resp.Code)
	}
}
