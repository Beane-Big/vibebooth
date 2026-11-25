package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNotifHubLifecycle(t *testing.T) {
	hub := newNotifHub()
	if hub.Online(1) {
		t.Fatal("user 1 should be offline initially")
	}
	ch, unsub := hub.Subscribe(1)
	if !hub.Online(1) {
		t.Fatal("user 1 should be online after subscribe")
	}
	hub.Publish(1, sseEvent{Name: "unread", Data: map[string]int{"unreadCount": 3}})
	select {
	case ev := <-ch:
		if ev.Name != "unread" {
			t.Fatalf("got event %q, want unread", ev.Name)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for sse event")
	}
	unsub()
	if hub.Online(1) {
		t.Fatal("user 1 should be offline after unsubscribe")
	}
}

func TestSanitizeNotificationLink(t *testing.T) {
	cases := map[string]string{
		"":                        "",
		"/contacts":               "/contacts",
		"/apps/forum/posts/42":    "/apps/forum/posts/42",
		"https://evil.example":    "",
		"//evil.example/phish":    "",
		"/apps/a\r\nSet-Cookie:1": "",
		"/apps/a b":               "",
	}
	for in, want := range cases {
		if got := sanitizeNotificationLink(in); got != want {
			t.Errorf("sanitizeNotificationLink(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidateChannelURL(t *testing.T) {
	valid := []string{
		"https://api.day.app/token/",
		"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
		"http://192.168.1.10:8080/hook",
	}
	for _, u := range valid {
		if _, err := validateChannelURL(u); err != nil {
			t.Errorf("validateChannelURL(%q) unexpected error: %v", u, err)
		}
	}
	invalid := []string{
		"",
		"ftp://example.com/hook",
		"javascript:alert(1)",
		"http://169.254.169.254/latest/meta-data/",
	}
	for _, u := range invalid {
		if _, err := validateChannelURL(u); err == nil {
			t.Errorf("validateChannelURL(%q) expected error", u)
		}
	}
}

func TestSendChannelPushFormats(t *testing.T) {
	var received map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	n := notification{
		AppID:     "feedback",
		Title:     "收到新建议",
		Body:      "支持深色模式",
		Link:      "/apps/feedback/1",
		CreatedAt: time.Now(),
	}
	for _, kind := range []string{"bark", "wecom", "feishu", "dingtalk", "webhook"} {
		received = nil
		err := sendChannelPush(context.Background(), notificationChannel{Kind: kind, TargetURL: srv.URL}, n)
		if err != nil {
			t.Fatalf("kind %s: %v", kind, err)
		}
		if received == nil {
			t.Fatalf("kind %s: expected JSON payload", kind)
		}
	}
}
