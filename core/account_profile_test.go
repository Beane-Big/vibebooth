package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestAdminCannotEditAccountIdentity 验证管理界面之外的资料写入同样被拒绝，备注和账号状态不影响身份资料。
func TestAdminCannotEditAccountIdentity(t *testing.T) {
	store := contactTestStore(t)
	ctx := context.Background()
	admin, err := store.CreateUser(ctx, "admin", "管理员", "original-pass", true)
	if err != nil {
		t.Fatal(err)
	}
	target, err := store.CreateUser(ctx, "target", "原姓名", "original-pass", false)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	update := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body))
		req.SetPathValue("id", fmt.Sprint(target.ID))
		w := httptest.NewRecorder()
		s.handleUpdateUser(w, req, admin)
		return w
	}
	for _, field := range []string{"displayName", "username", "name", "photo"} {
		w := update(fmt.Sprintf(`{"admin":false,"disabled":false,"%s":"changed"}`, field))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d %s", field, w.Code, w.Body)
		}
	}
	req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"name":"changed","note":"changed","photo":""}`))
	req.SetPathValue("id", fmt.Sprint(*target.PersonID))
	w := httptest.NewRecorder()
	s.handleUpdatePerson(w, req, admin)
	if w.Code != http.StatusForbidden {
		t.Fatalf("legacy profile editor returned %d", w.Code)
	}
	w = update(`{"admin":false,"disabled":true}`)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status: %d %s", w.Code, w.Body)
	}
	req = httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"remark":"备注"}`))
	req.SetPathValue("id", fmt.Sprint(target.ID))
	w = httptest.NewRecorder()
	s.handleSetUserRemark(w, req, admin)
	if w.Code != http.StatusNoContent {
		t.Fatalf("remark: %d %s", w.Code, w.Body)
	}
	user, err := store.UserByID(ctx, target.ID)
	if err != nil || user.Username != "target" || user.DisplayName != "原姓名" || !user.Disabled {
		t.Fatalf("identity changed: %+v %v", user, err)
	}
	person, err := store.PersonByID(ctx, *target.PersonID)
	if err != nil || person.Name != "原姓名" || person.Photo != "" || person.Note != "备注" {
		t.Fatalf("profile changed: %+v %v", person, err)
	}
	// 管理限制不影响本人通过专用接口修改自己的姓名及头像。
	req = httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"name":"本人修改"}`))
	w = httptest.NewRecorder()
	s.handleSetMyName(w, req, target)
	if w.Code != http.StatusOK {
		t.Fatalf("self name: %d %s", w.Code, w.Body)
	}
	req = httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"photo":"data:image/jpeg;base64,test"}`))
	w = httptest.NewRecorder()
	s.handleSetMyPhoto(w, req, target)
	if w.Code != http.StatusOK {
		t.Fatalf("self photo: %d %s", w.Code, w.Body)
	}
}
