package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Beane-Big/vibebooth/packages/manifest"
)

func TestThemeFiles(t *testing.T) {
	dir := t.TempDir()
	theme := filepath.Join(dir, ".themes", "aurora")
	os.MkdirAll(filepath.Join(theme, "assets"), 0o755)
	os.WriteFile(filepath.Join(theme, "theme.yaml"), []byte("id: aurora\nname: 极光\nversion: 0.1.0\nscript: theme.js\n"), 0o644)
	os.WriteFile(filepath.Join(theme, "theme.js"), []byte("1"), 0o644)
	os.WriteFile(filepath.Join(theme, "assets", "a.woff2"), []byte("font"), 0o644)
	os.WriteFile(filepath.Join(theme, "notes.txt"), []byte("x"), 0o644)
	s := &Server{registry: NewRegistry(dir)}

	if list := s.themes(); len(list) != 1 || list[0].ID != "aurora" {
		t.Fatalf("应列出 aurora，实际 %v", list)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/platform/themes/{id}/{path...}", func(w http.ResponseWriter, r *http.Request) { s.handleThemeFile(w, r, nil) })
	for url, want := range map[string]int{
		"/api/platform/themes/aurora/theme.js":       200,
		"/api/platform/themes/aurora/assets/a.woff2": 200,
		"/api/platform/themes/aurora/theme.yaml":     404,
		"/api/platform/themes/aurora/notes.txt":      404,
		"/api/platform/themes/other/theme.js":        404,
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
		if rec.Code != want {
			t.Errorf("%s 返回 %d，应为 %d", url, rec.Code, want)
		}
		if csp := rec.Header().Get("Content-Security-Policy"); want == 200 && !strings.HasPrefix(csp, "sandbox;") {
			t.Errorf("%s 应该带 sandbox 的 CSP，实际 %q", url, csp)
		}
	}
}

func TestValidSkin(t *testing.T) {
	themes := []*manifest.Theme{{ID: "aurora"}}
	for skin, want := range map[string]bool{
		"classic": true, "tiles": true, "theme:aurora": true,
		"theme:other": false, "aurora": false, "": false, "theme:": false,
	} {
		if got := validSkin(skin, themes); got != want {
			t.Errorf("validSkin(%q) = %v，应为 %v", skin, got, want)
		}
	}
}
