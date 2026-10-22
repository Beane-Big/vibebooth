package manifest

import "testing"

const base = "id: demo\nname: 演示\nversion: 0.1.0\nservices:\n  frontend: {port: 80}\n  backend: {port: 8000}\n" +
	"menus:\n  - {id: home, name: 首页, path: /apps/demo/}\n  - {id: settings, name: 设置, path: /apps/demo/settings/, default: [admin], settings: true}\n"

func TestParseDefaults(t *testing.T) {
	m, err := Parse([]byte(base))
	if err != nil {
		t.Fatal(err)
	}
	if d := m.Menus[0].Default; len(d) != 1 || d[0] != "user" {
		t.Errorf("菜单默认角色应为 [user]，实际 %v", d)
	}
	if got := m.BackendURL(); got != "http://demo-backend:8000" {
		t.Errorf("BackendURL = %q", got)
	}
	if got := m.HealthPath(); got != "/api/demo/health" {
		t.Errorf("HealthPath = %q", got)
	}
}

func TestParseRejects(t *testing.T) {
	cases := map[string]string{
		"保留 id":    "id: core\nname: x\nversion: 0.1.0\nservices: {backend: {port: 80}}\n",
		"大写 id":    "id: Demo\nname: x\nversion: 0.1.0\nservices: {backend: {port: 80}}\n",
		"缺 name":   "id: demo\nversion: 0.1.0\nservices: {backend: {port: 80}}\n",
		"版本格式":     "id: demo\nname: x\nversion: v1\nservices: {backend: {port: 80}}\n",
		"没有服务":     "id: demo\nname: x\nversion: 0.1.0\n",
		"未知服务":     "id: demo\nname: x\nversion: 0.1.0\nservices: {worker: {port: 80}}\n",
		"端口":       "id: demo\nname: x\nversion: 0.1.0\nservices: {backend: {port: 0}}\n",
		"未知字段":     base + "frontend: /apps/demo/\n",
		"图标带路径":    base + "icon: ../x.svg\n",
		"图标类型":     base + "icon: icon.js\n",
		"依赖自己":     base + "requires: [demo]\n",
		"菜单在别处":    base + "  - {id: x, name: x, path: /apps/other/}\n",
		"菜单带 ..":   base + "  - {id: x, name: x, path: /apps/demo/../other/}\n",
		"菜单是外部网站":  base + "  - {id: x, name: x, path: https://example.com/}\n",
		"菜单 id 重复": base + "  - {id: home, name: x, path: /apps/demo/x/}\n",
		"菜单路径重复":   base + "  - {id: x, name: x, path: /apps/demo/}\n",
		"菜单缺 name": base + "  - {id: x, path: /apps/demo/x/}\n",
		"有前端没有菜单":  "id: demo\nname: x\nversion: 0.1.0\nservices: {frontend: {port: 80}}\n",
		"有菜单没有前端":  "id: demo\nname: x\nversion: 0.1.0\nservices: {backend: {port: 80}}\nmenus: [{id: x, name: x, path: /apps/demo/}]\n",
	}
	for name, yaml := range cases {
		if _, err := Parse([]byte(yaml)); err == nil {
			t.Errorf("%s: 应该被拒绝", name)
		}
	}
}

func TestMenuFor(t *testing.T) {
	m, err := Parse([]byte(base))
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"/apps/demo/":               "home",
		"/apps/demo/assets/app.js":  "home",
		"/apps/demo/settings/":      "settings",
		"/apps/demo/settings/a?b=1": "settings",
		"/apps/demo/settingsx":      "home",
		"/apps/other/settings/":     "",
	}
	for path, want := range cases {
		got := ""
		if menu := m.MenuFor(path); menu != nil {
			got = menu.ID
		}
		if got != want {
			t.Errorf("MenuFor(%q) = %q, want %q", path, got, want)
		}
	}
}
