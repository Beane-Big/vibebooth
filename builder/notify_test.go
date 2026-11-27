package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

func TestNotifyBuildResult(t *testing.T) {
	var received []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/platform/ext/v1/notifications" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		received = append(received, payload)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	t.Setenv("CORE_URL", srv.URL)

	// 仅构建成功 -> 推送“前往安装”通知
	notifyBuildResult(&Build{ID: 1, ModuleID: "demo", ModuleName: "演示", Version: "1.0.0", InstallAfter: false}, nil)
	if len(received) != 1 {
		t.Fatalf("build-only success should notify once, got %d", len(received))
	}
	if title, _ := received[0]["title"].(string); !strings.Contains(title, "构建成功") {
		t.Errorf("unexpected title: %q", title)
	}

	// 构建并安装成功 -> 不推送通知
	received = nil
	notifyBuildResult(&Build{ID: 2, ModuleID: "demo", ModuleName: "演示", Version: "1.0.0", InstallAfter: true}, nil)
	if len(received) != 0 {
		t.Fatalf("build-and-install success should not notify, got %d", len(received))
	}

	// 构建并安装失败 -> 仍然推送构建失败通知
	received = nil
	notifyBuildResult(&Build{ID: 3, ModuleID: "demo", ModuleName: "演示", Version: "1.0.0", InstallAfter: true}, errors.New("boom"))
	if len(received) != 1 {
		t.Fatalf("build-and-install failure should still notify, got %d", len(received))
	}
	if title, _ := received[0]["title"].(string); !strings.Contains(title, "构建失败") {
		t.Errorf("unexpected title: %q", title)
	}
}

func TestUploadInstallAfter(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(filepath.Join(dir, "builder.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	b := newBuilder(store, nil, dir)
	h := &handlers{store: store, builder: b, links: newInstallLinks()}
	handler := auth.Standalone("admin")(http.HandlerFunc(h.upload))

	zipPath := writeZip(t, moduleFiles("")...)
	zipBytes, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name         string
		parts        []string // "installAfter" or "source"
		installValue string
		want         bool
	}{
		{name: "仅构建", parts: []string{"source"}, want: false},
		{name: "构建并安装_字段在前", parts: []string{"installAfter", "source"}, installValue: "true", want: true},
		{name: "构建并安装_字段在后", parts: []string{"source", "installAfter"}, installValue: "true", want: true},
		{name: "显式false", parts: []string{"installAfter", "source"}, installValue: "false", want: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var body bytes.Buffer
			mw := multipart.NewWriter(&body)
			for _, p := range tc.parts {
				switch p {
				case "source":
					fw, err := mw.CreateFormFile("source", "demo.zip")
					if err != nil {
						t.Fatal(err)
					}
					if _, err := io.Copy(fw, bytes.NewReader(zipBytes)); err != nil {
						t.Fatal(err)
					}
				case "installAfter":
					if err := mw.WriteField("installAfter", tc.installValue); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := mw.Close(); err != nil {
				t.Fatal(err)
			}

			req := httptest.NewRequest(http.MethodPost, "/api/platform/builder/builds", &body)
			req.Header.Set("Content-Type", mw.FormDataContentType())
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != http.StatusCreated {
				t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
			}
			var got Build
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got.InstallAfter != tc.want {
				t.Fatalf("response InstallAfter = %v, want %v", got.InstallAfter, tc.want)
			}
			stored, err := store.Get(context.Background(), got.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stored.InstallAfter != tc.want {
				t.Fatalf("stored InstallAfter = %v, want %v", stored.InstallAfter, tc.want)
			}
		})
	}
}
