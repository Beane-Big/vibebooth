package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStandalone(t *testing.T) {
	var got *User
	h := Standalone("本地用户")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = UserFrom(r.Context())
	}))

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/demo/me", nil))
	if got == nil || got.Name != "本地用户" || !got.Has("anything") || !got.HasMenu("home") {
		t.Fatalf("独立模式的本地用户应该拥有全部权限，得到 %+v", got)
	}

	// 带着网关注入的令牌说明跑在平台里，必须拒绝。
	got = nil
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/demo/me", nil)
	req.Header.Set("Authorization", "Bearer x")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || got != nil {
		t.Fatalf("带令牌的请求应该返回 403，得到 %d", rec.Code)
	}
}

func TestHas(t *testing.T) {
	u := &User{Menus: []string{"home"}, Perms: []string{"edit"}}
	if !u.Has("edit") || u.Has("clear") || !u.HasMenu("home") || u.HasMenu("settings") {
		t.Fatal("Has 和 HasMenu 应该只认令牌里的 id")
	}
}
