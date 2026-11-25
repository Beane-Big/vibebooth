package main

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protowire"
)

func TestDiagnoseBuild(t *testing.T) {
	diag := diagnoseBuild("dial tcp 1.2.3.4:443: i/o timeout https://proxy.golang.org/foo", Settings{})
	if diag == nil || diag.Category != "mirror" || len(diag.SuggestedArgs) != 1 || diag.SuggestedArgs[0].Name != "GOPROXY" {
		t.Fatalf("unexpected go mirror diagnosis: %+v", diag)
	}

	diag = diagnoseBuild("npm error request to https://registry.npmjs.org/vite failed, reason: ETIMEDOUT", Settings{})
	if diag == nil || len(diag.SuggestedArgs) != 1 || diag.SuggestedArgs[0].Name != "NPM_REGISTRY" {
		t.Fatalf("unexpected npm mirror diagnosis: %+v", diag)
	}

	diag = diagnoseBuild("Retrying after connection broken: https://pypi.org/simple/ timed out", Settings{})
	if diag == nil || len(diag.SuggestedArgs) != 1 || diag.SuggestedArgs[0].Name != "PIP_INDEX_URL" {
		t.Fatalf("unexpected pip mirror diagnosis: %+v", diag)
	}

	diag = diagnoseBuild("write /var/lib/docker: no space left on device", Settings{})
	if diag == nil || diag.Category != "disk" || !diag.CanPruneCache {
		t.Fatalf("unexpected disk diagnosis: %+v", diag)
	}

	diag = diagnoseBuild("process did not complete successfully: exit code: 137", Settings{})
	if diag == nil || diag.Category != "oom" {
		t.Fatalf("unexpected oom diagnosis: %+v", diag)
	}
}

func TestDownloadSkills(t *testing.T) {
	h := &handlers{}

	w := httptest.NewRecorder()
	h.downloadSkill(w, httptest.NewRequest(http.MethodGet, "/api/platform/builder/skill", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("app skill status = %d, body = %s", w.Code, w.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatalf("invalid app skill zip: %v", err)
	}
	var hasSkill, hasScript bool
	for _, f := range zr.File {
		if f.Name == "vibebooth-app-dev/SKILL.md" {
			hasSkill = true
		}
		if strings.HasSuffix(f.Name, "scripts/check-and-pack.mjs") {
			hasScript = true
		}
	}
	if !hasSkill || !hasScript {
		t.Fatalf("app skill zip missing expected files (hasSkill=%v, hasScript=%v)", hasSkill, hasScript)
	}

	w2 := httptest.NewRecorder()
	h.downloadThemeSkill(w2, httptest.NewRequest(http.MethodGet, "/api/platform/builder/theme-skill", nil))
	if w2.Code != http.StatusOK {
		t.Fatalf("theme skill status = %d, body = %s", w2.Code, w2.Body.String())
	}
	zr2, err := zip.NewReader(bytes.NewReader(w2.Body.Bytes()), int64(w2.Body.Len()))
	if err != nil {
		t.Fatalf("invalid theme skill zip: %v", err)
	}
	var hasThemeSkill, hasThemeScript bool
	for _, f := range zr2.File {
		if f.Name == "vibebooth-theme-dev/SKILL.md" {
			hasThemeSkill = true
		}
		if strings.HasSuffix(f.Name, "scripts/check-and-pack-theme.mjs") {
			hasThemeScript = true
		}
	}
	if !hasThemeSkill || !hasThemeScript {
		t.Fatalf("theme skill zip missing expected files (hasThemeSkill=%v, hasThemeScript=%v)", hasThemeSkill, hasThemeScript)
	}
}

func TestProgressVertexStatus(t *testing.T) {
	var buf bytes.Buffer
	p := newProgress(&buf)

	var v []byte
	v = protowire.AppendTag(v, 1, protowire.BytesType)
	v = protowire.AppendString(v, "v1")
	v = protowire.AppendTag(v, 3, protowire.BytesType)
	v = protowire.AppendString(v, "[1/3] FROM nginx:1.27-alpine")
	var ts []byte
	ts = protowire.AppendTag(ts, 1, protowire.VarintType)
	ts = protowire.AppendVarint(ts, 1700000000)
	v = protowire.AppendTag(v, 5, protowire.BytesType)
	v = protowire.AppendBytes(v, ts)

	var st []byte
	st = protowire.AppendTag(st, 1, protowire.BytesType)
	st = protowire.AppendString(st, "layer1")
	st = protowire.AppendTag(st, 2, protowire.BytesType)
	st = protowire.AppendString(st, "v1")
	st = protowire.AppendTag(st, 3, protowire.BytesType)
	st = protowire.AppendString(st, "downloading sha256:abc")
	st = protowire.AppendTag(st, 4, protowire.VarintType)
	st = protowire.AppendVarint(st, 5<<20)
	st = protowire.AppendTag(st, 5, protowire.VarintType)
	st = protowire.AppendVarint(st, 20<<20)

	var msg []byte
	msg = protowire.AppendTag(msg, 1, protowire.BytesType)
	msg = protowire.AppendBytes(msg, v)
	msg = protowire.AppendTag(msg, 2, protowire.BytesType)
	msg = protowire.AppendBytes(msg, st)

	p.write(msg)
	out := buf.String()
	if !strings.Contains(out, "downloading sha256:abc 5.0 MB / 20.0 MB (25%)") {
		t.Fatalf("expected download progress line in output, got:\n%s", out)
	}
}
