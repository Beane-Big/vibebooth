package main

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

func TestDownloadSkill(t *testing.T) {
	h := &handlers{}
	w := httptest.NewRecorder()
	h.downloadSkill(w, httptest.NewRequest(http.MethodGet, "/api/platform/builder/skill", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatalf("invalid zip: %v", err)
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
		t.Fatalf("skill zip missing expected files (hasSkill=%v, hasScript=%v)", hasSkill, hasScript)
	}
}
