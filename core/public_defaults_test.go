package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/Beane-Big/vibebooth/packages/manifest"
)

// TestPublicAppDefaults 验证公开应用给没有角色的新用户开放应用和普通页面，但不提升功能权限。
func TestPublicAppDefaults(t *testing.T) {
	m := testModule(t)
	user := &User{}
	access := appAccess{Scope: scopePublic, Version: m.Version}
	g := grants{Scopes: map[string]appAccess{m.ID: access}}
	if !appAllowed(user, m, g) || !slices.Equal(menuIDs(menusFor(user, m, g)), []string{"home", "settings"}) {
		t.Fatal("public app and ordinary pages must default to enabled")
	}
	if len(permsFor(user, m, g)) != 0 || canOpenPage(m, menusFor(user, m, g), "/apps/demo/board/") {
		t.Fatal("public access must not grant capabilities or capability-bound pages")
	}
	g.Menus = grantMap{m.ID: {"settings": false}}
	if !slices.Equal(menuIDs(menusFor(user, m, g)), []string{"home"}) {
		t.Fatal("explicit page denial must win")
	}
	g.Apps = map[string]bool{m.ID: false}
	if appAllowed(user, m, g) || len(menusFor(user, m, g)) != 0 {
		t.Fatal("explicit app denial must win")
	}
	g.Apps = nil
	g.Menus = nil
	for _, scope := range []appAccess{
		{Scope: scopePublic, Version: "old-version"},
		{Scope: scopeRestricted, Version: m.Version},
		{Scope: scopeSignedIn, Version: m.Version},
	} {
		g.Scopes[m.ID] = scope
		if appAllowed(user, m, g) || len(menusFor(user, m, g)) != 0 {
			t.Fatalf("unexpected public default: %+v", scope)
		}
	}
}

// TestPublicDefaultsPermissionView 使用真实数据库检查权限页的默认值、覆盖值和实际菜单始终一致。
func TestPublicDefaultsPermissionView(t *testing.T) {
	store := contactTestStore(t)
	ctx := context.Background()
	user, err := store.CreateUser(ctx, "public_user", "", "testing-password", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.pool.Exec(ctx, `UPDATE users SET roles='{}' WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	user.Roles = nil
	m := testModule(t)
	_, err = store.pool.Exec(ctx, `INSERT INTO app_access(module_id,version,scope) VALUES($1,$2,$3)`, m.ID, m.Version, scopePublic)
	if err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry(t.TempDir())
	registry.modules[m.ID] = m
	server := &Server{store: store, registry: registry}
	view := func() moduleGrantView {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.SetPathValue("id", fmt.Sprint(user.ID))
		w := httptest.NewRecorder()
		server.handleUserMenus(w, req, &User{})
		if w.Code != 200 {
			t.Fatalf("permission view: %d %s", w.Code, w.Body)
		}
		var out struct {
			Modules []moduleGrantView `json:"modules"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		for _, item := range out.Modules {
			if item.ID == m.ID {
				return item
			}
		}
		t.Fatal("missing app")
		return moduleGrantView{}
	}
	v := view()
	if !v.Access.Default || !v.Access.Allowed || v.Access.Override != nil {
		t.Fatalf("app: %+v", v.Access)
	}
	for _, menu := range v.Menus {
		if !menu.Default || !menu.Allowed || menu.Override != nil {
			t.Fatalf("menu: %+v", menu)
		}
	}
	for _, perm := range v.Perms {
		if perm.Allowed {
			t.Fatalf("capability unexpectedly enabled: %+v", perm)
		}
	}
	no := false
	if err = store.SetGrant(ctx, user.ID, m.ID, "settings", &no); err != nil {
		t.Fatal(err)
	}
	v = view()
	for _, menu := range v.Menus {
		if menu.ID == "settings" && (!menu.Default || menu.Allowed || menu.Override == nil || *menu.Override) {
			t.Fatalf("override: %+v", menu)
		}
	}
	g, err := store.Grants(ctx, user.ID)
	if err != nil || !slices.Equal(menuIDs(menusFor(user, m, g)), []string{"home"}) {
		t.Fatalf("actual grants differ: %v %v", menuIDs(menusFor(user, m, g)), err)
	}
	if _, err = store.pool.Exec(ctx, `DELETE FROM app_access WHERE module_id=$1`, m.ID); err != nil {
		t.Fatal(err)
	}
	v = view()
	if v.Access.Default || v.Access.Allowed {
		t.Fatal("removing public access must restore manifest defaults")
	}
	for _, menu := range v.Menus {
		if menu.Default || menu.Allowed {
			t.Fatalf("stale public default: %+v", menu)
		}
	}
}

// TestPublicDefaultsPreserveOptIn 覆盖公开范围、角色默认和逐人授权交叉时的功能权限边界。
func TestPublicDefaultsPreserveOptIn(t *testing.T) {
	m := testModule(t)
	m.Permissions = append(m.Permissions, manifest.Permission{ID: "private", Name: "逐人开通", OptIn: true})
	m.Menus = append(m.Menus, manifest.Menu{ID: "private", Name: "专属页面", Path: "/apps/demo/private/", Requires: "private"})
	for _, roles := range [][]string{nil, {"user"}, {"admin", "user"}} {
		user := &User{Roles: roles}
		g := grants{Scopes: map[string]appAccess{m.ID: {Scope: scopePublic, Version: m.Version}}}
		if !appAllowed(user, m, g) || !slices.Contains(menuIDs(menusFor(user, m, g)), "settings") {
			t.Fatalf("public app or ordinary page disabled for %v", roles)
		}
		if slices.Contains(permsFor(user, m, g), "private") || canOpenPage(m, menusFor(user, m, g), "/apps/demo/private/") {
			t.Fatalf("opt-in capability automatically granted for %v", roles)
		}
		g.Perms = grantMap{m.ID: {"private": true}}
		if !slices.Contains(permsFor(user, m, g), "private") || !canOpenPage(m, menusFor(user, m, g), "/apps/demo/private/") {
			t.Fatalf("explicit opt-in not effective for %v", roles)
		}
		g.Perms[m.ID]["private"] = false
		if slices.Contains(permsFor(user, m, g), "private") || canOpenPage(m, menusFor(user, m, g), "/apps/demo/private/") {
			t.Fatalf("opt-in denial not effective for %v", roles)
		}
	}
}
