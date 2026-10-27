package main

import (
	"archive/zip"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

const themeYAML = "id: aurora\nname: 极光\nversion: 0.1.0\nscript: theme.js\nstyle: theme.css\n"

func writeZip(t *testing.T, files map[string]string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "theme.zip")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, body := range files {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()
	f.Close()
	return p
}

func TestInstallTheme(t *testing.T) {
	in := &Installer{dir: t.TempDir()}
	pkg := writeZip(t, map[string]string{"theme.yaml": themeYAML, "theme.js": "1", "theme.css": "a{}", "assets/bg.png": "png"})

	var script *ScriptError
	if _, err := in.InstallTheme(pkg, false, io.Discard); !errors.As(err, &script) {
		t.Fatalf("带脚本的主题没确认时应返回 ScriptError，实际 %v", err)
	}
	if _, err := in.InstallTheme(pkg, true, io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(in.dir, ".themes", "aurora", "assets", "bg.png")); err != nil {
		t.Errorf("assets 应该解压出来: %v", err)
	}
	if got := in.themes(); got["aurora"] == nil || got["aurora"].Version != "0.1.0" {
		t.Errorf("应列出已安装的主题，实际 %v", got)
	}
	if err := in.UninstallTheme("aurora", io.Discard); err != nil {
		t.Fatal(err)
	}
	if len(in.themes()) != 0 {
		t.Error("卸载后不应再列出")
	}
}

func TestInstallThemeRejects(t *testing.T) {
	in := &Installer{dir: t.TempDir()}
	for name, files := range map[string]map[string]string{
		"缺少清单":      {"theme.css": "a{}"},
		"缺少声明的文件":   {"theme.yaml": themeYAML, "theme.css": "a{}"},
		"多余的文件":     {"theme.yaml": themeYAML, "theme.js": "1", "theme.css": "a{}", "index.html": "x"},
		"跳出目录":      {"theme.yaml": themeYAML, "theme.js": "1", "theme.css": "a{}", "assets/../../x.js": "x"},
		"不允许的类型":    {"theme.yaml": themeYAML, "theme.js": "1", "theme.css": "a{}", "assets/run.sh": "x"},
		"没声明脚本却带脚本": {"theme.yaml": "id: aurora\nname: 极光\nversion: 0.1.0\nstyle: theme.css\n", "theme.css": "a{}", "assets/x.js": "x"},
	} {
		if _, err := in.InstallTheme(writeZip(t, files), true, io.Discard); err == nil {
			t.Errorf("%s：应该报错", name)
		}
	}
}
