package main

import (
	"slices"
	"testing"

	"github.com/Beane-Big/vibebooth/packages/manifest"
)

func testModule(t *testing.T) *Module {
	t.Helper()
	m, err := manifest.Parse([]byte("id: demo\nname: 演示\nversion: 0.1.0\nservices: {frontend: {port: 80}}\nmenus:\n" +
		"  - {id: home, name: 首页, path: /apps/demo/}\n" +
		"  - {id: settings, name: 设置, path: /apps/demo/settings/, default: [admin], settings: true}\n" +
		"  - {id: board, name: 记分板, path: /apps/demo/board/, requires: score}\n" +
		"permissions:\n  - {id: score, name: 记分}\n  - {id: reset, name: 清零, default: [admin]}\n"))
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
		name  string
		user  *User
		g     grants
		menus []string
		perms []string
	}{
		{"普通用户按默认值", user, grants{}, []string{"home", "board"}, []string{"score"}},
		{"单独允许设置", user, grants{Menus: grantMap{"demo": {"settings": yes}}}, []string{"home", "settings", "board"}, []string{"score"}},
		{"单独禁止首页", user, grants{Menus: grantMap{"demo": {"home": no}}}, []string{"board"}, []string{"score"}},
		{"别的模块的设置不影响", user, grants{Menus: grantMap{"other": {"settings": yes}}}, []string{"home", "board"}, []string{"score"}},
		{"去掉功能权限，跟着它的菜单也没了", user, grants{Perms: grantMap{"demo": {"score": no}}}, []string{"home"}, nil},
		{"菜单跟着权限走，不看菜单的单独设置", user, grants{Menus: grantMap{"demo": {"board": yes}}, Perms: grantMap{"demo": {"score": no}}}, []string{"home"}, nil},
		{"单独给清零", user, grants{Perms: grantMap{"demo": {"reset": yes}}}, []string{"home", "board"}, []string{"score", "reset"}},
		{"管理员总有全部", admin, grants{Menus: grantMap{"demo": {"settings": no, "home": no}}, Perms: grantMap{"demo": {"score": no}}},
			[]string{"home", "settings", "board"}, []string{"score", "reset"}},
	}
	same := func(a, b []string) bool { return slices.Equal(a, b) || (len(a) == 0 && len(b) == 0) }
	for _, c := range cases {
		if got := menuIDs(menusFor(c.user, m, c.g)); !same(got, c.menus) {
			t.Errorf("%s: menus = %v, want %v", c.name, got, c.menus)
		}
		if got := permsFor(c.user, m, c.g); !same(got, c.perms) {
			t.Errorf("%s: perms = %v, want %v", c.name, got, c.perms)
		}
	}
}

func TestAppAllowed(t *testing.T) {
	m := testModule(t)
	user := &User{Roles: []string{"user"}}
	admin := &User{Roles: []string{"admin", "user"}}
	off := grants{Apps: map[string]bool{"demo": false, "platform": false}}
	if appAllowed(user, m, grants{}) != true || appAllowed(user, platformModule, grants{}) != true {
		t.Error("默认应该能用有默认菜单的应用和平台")
	}
	if appAllowed(user, m, off) || menusFor(user, m, off) != nil || permsFor(user, m, off) != nil {
		t.Error("关掉应用后菜单和功能权限都不应生效")
	}
	if appAllowed(user, platformModule, off) || permsFor(user, platformModule, off) != nil {
		t.Error("关掉平台后平台权限都不应生效")
	}
	if !appAllowed(admin, m, off) || !appAllowed(admin, platformModule, off) {
		t.Error("管理员总能用")
	}
	noMenus := grants{Menus: grantMap{"demo": {"home": false}}, Perms: grantMap{"demo": {"score": false}}}
	if appAllowed(user, m, noMenus) {
		t.Error("没有单独设置时，一个菜单都没有就不能用")
	}
	noMenus.Apps = map[string]bool{"demo": true}
	if !appAllowed(user, m, noMenus) {
		t.Error("单独打开后应该能用")
	}
	if menus := menusFor(user, m, noMenus); len(menus) != 0 || canOpenPage(m, menus, "/apps/demo/") {
		t.Error("应用开着、页面都关着时有入口，但一个页面都打不开")
	}
	backend, err := manifest.Parse([]byte("id: hook\nname: 钩子\nversion: 0.1.0\nservices: {backend: {port: 8000}}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if appAllowed(admin, &Module{Manifest: backend}, grants{Apps: map[string]bool{"hook": true}}) {
		t.Error("只有后端的模块没有入口，管理员也不能用")
	}
}

func TestPlatformPerms(t *testing.T) {
	user := &User{Roles: []string{"user"}}
	if got := permsFor(user, platformModule, grants{}); !slices.Equal(got, []string{permSettings}) {
		t.Errorf("普通用户默认只有设置，实际 %v", got)
	}
	g := grants{Perms: grantMap{"platform": {permModules: true}}}
	if got := permsFor(user, platformModule, g); !slices.Equal(got, []string{permSettings, permModules}) {
		t.Errorf("单独给了应用管理，实际 %v", got)
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
