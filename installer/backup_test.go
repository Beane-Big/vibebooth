package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestBackupSettingsMaskAndKeepPassword(t *testing.T) {
	dir := t.TempDir()
	bm := newBackupManager(dir, "", "", "", "", "Asia/Shanghai")

	st, err := bm.SaveSettings(BackupSettings{
		Enabled:        true,
		Frequency:      "daily",
		Hour:           4,
		Weekday:        0,
		IncludeModules: true,
		KeepCount:      10,
		WebDAVEnabled:  true,
		WebDAVURL:      "https://dav.example.com/vibebooth",
		WebDAVUsername: "alice",
		WebDAVPassword: "secret-password",
	})
	if err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	if !st.WebDAVPasswordSet || st.WebDAVPassword != "" {
		t.Fatalf("expected masked password, got %+v", st)
	}

	// 再次保存时不传密码但带 webdavPasswordSet=true，应保留原密码。
	st.Hour = 5
	if _, err := bm.SaveSettings(st); err != nil {
		t.Fatalf("SaveSettings keep pwd: %v", err)
	}
	raw, err := bm.LoadSettings()
	if err != nil {
		t.Fatal(err)
	}
	if raw.WebDAVPassword != "secret-password" || raw.Hour != 5 {
		t.Fatalf("expected saved password preserved, got %+v", raw)
	}
}

func TestBackupCreateListRestoreDirRoundTrip(t *testing.T) {
	root := t.TempDir()
	backupsDir := filepath.Join(root, "backups")
	coreDir := filepath.Join(root, "core-data")
	modsDir := filepath.Join(root, "modules-data")
	_ = os.MkdirAll(filepath.Join(coreDir, "site"), 0o755)
	_ = os.MkdirAll(filepath.Join(modsDir, ".themes", "demo"), 0o755)
	_ = os.WriteFile(filepath.Join(coreDir, "site", "logo.svg"), []byte("<svg/>"), 0o644)
	_ = os.WriteFile(filepath.Join(modsDir, ".themes", "demo", "theme.css"), []byte("body{}"), 0o644)

	bm := newBackupManager(backupsDir, modsDir, coreDir, "", "", "Asia/Shanghai")
	rec, err := bm.RunBackup(context.Background(), "manual", false)
	if err != nil {
		t.Fatalf("RunBackup: %v", err)
	}
	if rec.Size <= 0 || len(rec.Volumes) != 2 {
		t.Fatalf("unexpected record: %+v", rec)
	}
	list, err := bm.ListBackups()
	if err != nil || len(list) != 1 || list[0].ID != rec.ID {
		t.Fatalf("ListBackups: %+v, err=%v", list, err)
	}

	// 修改原文件后执行恢复，应还原回备份时的内容。
	_ = os.WriteFile(filepath.Join(coreDir, "site", "logo.svg"), []byte("changed"), 0o644)
	_ = os.Remove(filepath.Join(modsDir, ".themes", "demo", "theme.css"))

	if err := bm.RestoreFromFile(context.Background(), bm.archivePath(rec.ID)); err != nil {
		t.Fatalf("RestoreFromFile: %v", err)
	}
	gotLogo, err := os.ReadFile(filepath.Join(coreDir, "site", "logo.svg"))
	if err != nil || string(gotLogo) != "<svg/>" {
		t.Fatalf("logo not restored: %q %v", gotLogo, err)
	}
	gotCSS, err := os.ReadFile(filepath.Join(modsDir, ".themes", "demo", "theme.css"))
	if err != nil || string(gotCSS) != "body{}" {
		t.Fatalf("theme.css not restored: %q %v", gotCSS, err)
	}
}

func TestWebDAVTestAndUpload(t *testing.T) {
	var putReceived bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != "alice" || p != "pass123" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case "PROPFIND":
			w.WriteHeader(http.StatusMultiStatus)
		case http.MethodPut:
			putReceived = true
			w.WriteHeader(http.StatusCreated)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer srv.Close()

	if err := testWebDAV(context.Background(), srv.URL, "alice", "pass123"); err != nil {
		t.Fatalf("testWebDAV valid: %v", err)
	}
	if err := testWebDAV(context.Background(), srv.URL, "alice", "wrong"); err == nil {
		t.Fatal("expected auth failure")
	}

	tmp := filepath.Join(t.TempDir(), "test.tar.gz")
	_ = os.WriteFile(tmp, []byte("hello"), 0o600)
	if err := uploadWebDAV(context.Background(), srv.URL, "alice", "pass123", "test.tar.gz", tmp); err != nil {
		t.Fatalf("uploadWebDAV: %v", err)
	}
	if !putReceived {
		t.Fatal("expected PUT upload to WebDAV server")
	}
}
