package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleSite(t *testing.T) {
	s := &Server{cfg: config{ICPBeian: "京ICP备00000000号-1", PoliceBeian: "京公网安备11010000000123号"}}
	w := httptest.NewRecorder()
	s.handleSite(w, httptest.NewRequest(http.MethodGet, "/api/platform/site", nil))
	var got site
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	want := site{
		Name:              defaultSiteName,
		ICP:               "京ICP备00000000号-1",
		Police:            "京公网安备11010000000123号",
		PoliceCode:        "11010000000123",
		AllowRegistration: true,
	}
	if w.Code != http.StatusOK || got != want {
		t.Errorf("status %d, got %+v, want %+v", w.Code, got, want)
	}
}

func TestValidateHTTPSOrEmpty(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"", "", true},
		{"  ", "", true},
		{"https://example.com/terms", "https://example.com/terms", true},
		{"http://example.com/terms", "", false},
		{"javascript:alert(1)", "", false},
		{"https://user:pass@example.com/terms", "", false},
	}
	for _, tc := range cases {
		got, ok := validateHTTPSOrEmpty(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("validateHTTPSOrEmpty(%q) = (%q, %v), want (%q, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestEncodeSiteLogoPNGAndSVGCheck(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 800, 400))
	img.Set(0, 0, color.NRGBA{R: 100, G: 150, B: 200, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	out, err := encodeSiteLogoPNG(buf.Bytes())
	if err != nil {
		t.Fatalf("encodeSiteLogoPNG failed: %v", err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != maxSiteLogoDim || cfg.Height != maxSiteLogoDim/2 {
		t.Errorf("resized logo = %dx%d, want %dx%d", cfg.Width, cfg.Height, maxSiteLogoDim, maxSiteLogoDim/2)
	}

	if !looksLikeSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)) {
		t.Error("expected svg to be detected")
	}
	if !unsafeSVGPattern.MatchString(`<svg onload="alert(1)"></svg>`) {
		t.Error("expected onload in svg to be rejected")
	}
	if !unsafeSVGPattern.MatchString(`<svg><script>alert(1)</script></svg>`) {
		t.Error("expected script in svg to be rejected")
	}
}
