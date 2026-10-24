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

func TestRenewedExpiry(t *testing.T) {
	login := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	day := 24 * time.Hour
	cases := []struct {
		name         string
		now, expires time.Time
		want         time.Time
		renew        bool
	}{
		{"剩余时间还多，不续期", login.Add(day), login.Add(sessionIdle), login.Add(sessionIdle), false},
		{"剩余不到一半，续到 7 天后", login.Add(5 * day), login.Add(sessionIdle), login.Add(5*day + sessionIdle), true},
		{"快到 30 天，只续到登录后 30 天", login.Add(28 * day), login.Add(29 * day), login.Add(sessionMaxAge), true},
		{"已经续到 30 天上限，不再写库", login.Add(29 * day), login.Add(sessionMaxAge), login.Add(sessionMaxAge), false},
	}
	for _, c := range cases {
		got, renew := renewedExpiry(c.now, login, c.expires)
		if !got.Equal(c.want) || renew != c.renew {
			t.Errorf("%s: got %v %v, want %v %v", c.name, got, renew, c.want, c.renew)
		}
	}
}
