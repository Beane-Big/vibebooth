package main

import (
	"testing"
	"time"
)

func TestAppIDFromURI(t *testing.T) {
	cases := map[string]string{
		"/apps/hello/":          "hello",
		"/apps/hello/index.js":  "hello",
		"/api/hello/greeting":   "hello",
		"/api/hello?x=1":        "hello",
		"/apps/hello?next=/a/b": "hello",
		"/":                     "",
		"/login":                "",
		"/other/hello/":         "",
	}
	for uri, want := range cases {
		if got := appIDFromURI(uri); got != want {
			t.Errorf("appIDFromURI(%q) = %q, want %q", uri, got, want)
		}
	}
}

func TestLoginLimiter(t *testing.T) {
	l := newLoginLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		if !l.Allow("1.2.3.4") {
			t.Fatalf("attempt %d should be allowed", i)
		}
		l.Fail("1.2.3.4")
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("should be blocked after 3 failures")
	}
	if !l.Allow("5.6.7.8") {
		t.Fatal("other IPs should not be affected")
	}
	l.Reset("1.2.3.4")
	if !l.Allow("1.2.3.4") {
		t.Fatal("should be allowed after reset")
	}
}
