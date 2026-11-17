package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestGoogleAccountSelection(t *testing.T) {
	t.Setenv("GOOGLE_CLIENT_ID", "test-client")
	t.Setenv("GOOGLE_CLIENT_SECRET", "test-secret")
	t.Setenv("GOOGLE_REDIRECT_URL", "https://example.org/api/platform/auth/google/callback")
	cfg, enabled := googleOAuthConfig()
	if !enabled {
		t.Fatal("valid Google OAuth configuration was disabled")
	}
	mux := http.NewServeMux()
	(&Server{}).mountGoogleAuth(mux, cfg)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("GET", "https://example.org/api/platform/auth/google", nil))
	location, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	query := location.Query()
	if response.Code != http.StatusSeeOther || location.Host != "accounts.google.com" ||
		query.Get("prompt") != "select_account" || query.Get("code_challenge_method") != "S256" ||
		query.Get("state") == "" || query.Get("nonce") != query.Get("state") {
		t.Fatal("invalid Google account selection redirect")
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Name != googleFlowCookie {
		t.Fatal("invalid Google flow cookie")
	}
	invalid := httptest.NewRequest("GET", "https://example.org/api/platform/auth/google/callback?code=test&state=invalid", nil)
	invalid.AddCookie(cookies[0])
	callback := httptest.NewRecorder()
	mux.ServeHTTP(callback, invalid)
	if callback.Code != http.StatusSeeOther || callback.Header().Get("Location") != "/login?google_error=1" {
		t.Fatal("callback with invalid state was not rejected")
	}
}
