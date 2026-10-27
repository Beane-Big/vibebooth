package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWriteDenied(t *testing.T) {
	m := testModule(t)
	for reason, want := range map[deniedReason]string{
		deniedApp:     "你没有「演示」的使用权限",
		deniedNoPages: "暂无可访问的页面",
		deniedPage:    "无权访问此页面",
	} {
		w := httptest.NewRecorder()
		writeDenied(w, m, reason)
		if w.Code != http.StatusForbidden || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") {
			t.Errorf("%d: status %d, type %q", reason, w.Code, w.Header().Get("Content-Type"))
		}
		if !strings.Contains(w.Body.String(), want) {
			t.Errorf("%d: 提示页里没有 %q", reason, want)
		}
	}
}
