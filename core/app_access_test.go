package main

import (
	"net/http"
	"testing"

	"github.com/Beane-Big/vibebooth/packages/manifest"
)

func TestGuestAccessOnlyForCanonicalFrontendReads(t *testing.T) {
	m := &Module{Manifest: &manifest.Manifest{ID: "bishun", Version: "1.0.0",
		Services: map[string]manifest.Service{manifest.Frontend: {Port: 80}}}}
	for _, tc := range []struct {
		method, path string
		want         bool
	}{
		{http.MethodGet, "/apps/bishun/", true},
		{http.MethodHead, "/apps/bishun/assets/index.js", true},
		{http.MethodGet, "/api/bishun/hard-words", false},
		{http.MethodPost, "/apps/bishun/", false},
		{http.MethodGet, "/apps/bishun/../builder/", false},
		{http.MethodGet, "/apps/bishun/%2e%2e/builder/", false},
		{http.MethodGet, "/apps/bishun//assets/index.js", false},
		{http.MethodGet, "/apps/pinyin/", false},
	} {
		if got := publicFrontendRequest(m, tc.path, tc.method); got != tc.want {
			t.Errorf("%s %s = %t, want %t", tc.method, tc.path, got, tc.want)
		}
	}
	if canBrowseApp(m, scopeSignedIn, false) || !canBrowseApp(m, scopeSignedIn, true) {
		t.Fatal("signed-in scope must only allow logged-in users")
	}
	if (appAccess{Version: "0.9.0", Scope: scopePublic}).forModule(m) != scopeRestricted {
		t.Fatal("a different module version must not inherit public access")
	}
}
