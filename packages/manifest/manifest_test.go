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
		"依赖写法":     base + "requires: [people>0.2]\n",
		"依赖版本格式":   base + "requires: [people>=v1]\n",
		"规范版本太高":   base + "platform: 2\n",
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

func TestRequires(t *testing.T) {
	m, err := Parse([]byte(base + "requires: [people, family>=0.2, other >= 1.2.3]\n"))
	if err != nil {
		t.Fatal(err)
	}
	want := []Requirement{{ID: "people"}, {ID: "family", Min: "0.2.0"}, {ID: "other", Min: "1.2.3"}}
	if len(m.Deps) != len(want) {
		t.Fatalf("Deps = %v", m.Deps)
	}
	for i, d := range m.Deps {
		if d != want[i] {
			t.Errorf("Deps[%d] = %v，应为 %v", i, d, want[i])
		}
	}
	if m.Platform != 1 {
		t.Errorf("platform 默认应为 1，实际 %d", m.Platform)
	}
	cases := []struct {
		version string
		ok      bool
	}{{"0.1.9", false}, {"0.2.0", true}, {"0.10.0", true}, {"1.0.0", true}}
	for _, c := range cases {
		if got := m.Deps[1].SatisfiedBy(c.version); got != c.ok {
			t.Errorf("family>=0.2 对 %s 应为 %v", c.version, c.ok)
		}
	}
	if !m.Deps[0].SatisfiedBy("0.0.1") {
		t.Error("不写版本时任何版本都应满足")
	}
}
