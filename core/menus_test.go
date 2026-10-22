package main

import (
	"slices"
	"testing"

	"github.com/Beane-Big/home-platform/packages/manifest"
)

func testModule(t *testing.T) *Module {
	t.Helper()
	m, err := manifest.Parse([]byte("id: demo\nname: 演示\nversion: 0.1.0\nservices: {frontend: {port: 80}}\nmenus:\n" +
		"  - {id: home, name: 首页, path: /apps/demo/}\n" +
		"  - {id: settings, name: 设置, path: /apps/demo/settings/, default: [admin], settings: true}\n"))
	if err != nil {
		t.Fatal(err)
	}
	return &Module{Manifest: m}
}

func TestMenusFor(t *testing.T) {
	m := testModule(t)
	user := &User{Roles: []string{"user"}}
	admin := &User{Roles: []string{"admin", "user"}}
	no, yes := false, true
	cases := []struct {
		name string
		user *User
		g    grants
		want []string
	}{
		{"普通用户按默认值", user, grants{}, []string{"home"}},
		{"单独允许设置", user, grants{"demo": {"settings": yes}}, []string{"home", "settings"}},
		{"单独禁止首页", user, grants{"demo": {"home": no}}, nil},
		{"别的模块的设置不影响", user, grants{"other": {"settings": yes}}, []string{"home"}},
		{"管理员总有全部菜单", admin, grants{"demo": {"settings": no, "home": no}}, []string{"home", "settings"}},
	}
	for _, c := range cases {
		if got := menuIDs(menusFor(c.user, m, c.g)); !slices.Equal(got, c.want) && !(len(got) == 0 && len(c.want) == 0) {
			t.Errorf("%s: menus = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestCanOpenPage(t *testing.T) {
	m := testModule(t)
	home := []manifest.Menu{*m.MenuByID("home")}
	settings := []manifest.Menu{*m.MenuByID("settings")}
	cases := []struct {
		menus []manifest.Menu
		path  string
		want  bool
	}{
		{home, "/apps/demo/", true},
		{home, "/apps/demo/assets/app.js", true},
		{home, "/apps/demo/settings/", false},
		{home, "/apps/demo/settings", false},
		// 只有设置菜单的人也要能加载首页路径下的静态资源，设置页才能显示。
		{settings, "/apps/demo/assets/app.js", true},
		{settings, "/apps/demo/settings/", true},
		{nil, "/apps/demo/", false},
	}
	for _, c := range cases {
		if got := canOpenPage(m, c.menus, c.path); got != c.want {
			t.Errorf("menus=%v path=%s: got %v, want %v", menuIDs(c.menus), c.path, got, c.want)
		}
	}
}
