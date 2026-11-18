package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

func TestAdminOnlyBuilds(t *testing.T) {
	h := adminOnly(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/platform/builder/builds", nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("missing user returned %d", w.Code)
	}
	w = httptest.NewRecorder()
	auth.Standalone("admin")(h).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/platform/builder/builds", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("admin returned %d", w.Code)
	}
}

func TestPlatformBuildDefaults(t *testing.T) {
	t.Setenv("GOPROXY", "https://example.org/go,direct")
	t.Setenv("NPM_REGISTRY", "https://example.org/npm/")
	store, err := OpenStore(t.TempDir() + "/builder.db")
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	settings, err := store.Settings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(settings.Arg("GOPROXY"), "example.org") || settings.Arg("NPM_REGISTRY") == "" {
		t.Fatal("platform defaults were not inherited")
	}
}
