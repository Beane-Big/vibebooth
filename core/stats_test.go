package main

import "testing"

func TestDeviceType(t *testing.T) {
	cases := []struct {
		ua    string
		touch bool
		want  string
	}{
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", true, "phone"},
		{"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36", true, "phone"},
		{"Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", true, "tablet"},
		{"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", true, "tablet"},
		// iPadOS 的 Safari 默认报 Mac 的 User-Agent，靠触摸屏区分。
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", true, "tablet"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", false, "desktop"},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", true, "desktop"},
		{"", false, "desktop"},
	}
	for _, c := range cases {
		if got := deviceType(c.ua, c.touch); got != c.want {
			t.Errorf("deviceType(%q, %v) = %q, want %q", c.ua, c.touch, got, c.want)
		}
	}
}

func TestBuiltinStatsApp(t *testing.T) {
	for app, want := range map[string]bool{
		"portal": true, "portal:users": true, "portal:stats": true,
		"portal:": false, "portal:Users": false, "portalx": false, "notes": false, "": false,
	} {
		if got := builtinStatsApp.MatchString(app); got != want {
			t.Errorf("%q: got %v, want %v", app, got, want)
		}
	}
}
