package main

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
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

func TestExportTheme(t *testing.T) {
	dir := t.TempDir()
	theme := filepath.Join(dir, ".themes", "aurora")
	os.MkdirAll(filepath.Join(theme, "assets", "img"), 0o755)
	os.WriteFile(filepath.Join(theme, "theme.yaml"), []byte("id: aurora\nname: 极光\nversion: 0.2.0\nscript: theme.js\nstyle: theme.css\n"), 0o644)
	os.WriteFile(filepath.Join(theme, "theme.js"), []byte("1"), 0o644)
	os.WriteFile(filepath.Join(theme, "theme.css"), []byte("a{}"), 0o644)
	os.WriteFile(filepath.Join(theme, "assets", "img", "bg.svg"), []byte("<svg/>"), 0o644)
	os.WriteFile(filepath.Join(theme, "assets", "notes.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(theme, "extra.js"), []byte("x"), 0o644)
	s := &Server{registry: NewRegistry(dir)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/platform/themes/{id}/{path...}", func(w http.ResponseWriter, r *http.Request) { s.handleThemeFile(w, r, nil) })
	mux.HandleFunc("GET /api/platform/themes/{id}/export", func(w http.ResponseWriter, r *http.Request) { s.handleExportTheme(w, r, nil) })

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/platform/themes/aurora/export", nil))
	if rec.Code != 200 {
		t.Fatalf("导出返回 %d：%s", rec.Code, rec.Body)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, `filename="aurora-0.2.0.zip"`) {
		t.Errorf("文件名不对：%q", cd)
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	slices.Sort(names)
	// 只打包安装器认的文件：清单、声明的文件和合法的 assets/，其他文件不带。
	if want := []string{"assets/img/bg.svg", "theme.css", "theme.js", "theme.yaml"}; !slices.Equal(names, want) {
		t.Errorf("包里的文件是 %v，应为 %v", names, want)
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/platform/themes/other/export", nil))
	if rec.Code != 404 {
		t.Errorf("没装的主题应返回 404，实际 %d", rec.Code)
	}
}
