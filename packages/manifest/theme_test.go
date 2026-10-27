package manifest

import "testing"

func TestParseTheme(t *testing.T) {
	th, err := ParseTheme([]byte("id: aurora\nname: 极光\nversion: 0.1.0\nscript: theme.js\nstyle: theme.css\npreview: preview.png\n"))
	if err != nil {
		t.Fatal(err)
	}
	if th.Platform != 1 || len(th.Files()) != 3 {
		t.Errorf("应补上 platform 1 并列出 3 个文件，实际 %+v", th)
	}
}

func TestParseThemeInvalid(t *testing.T) {
	for name, yaml := range map[string]string{
		"没有文件":   "id: aurora\nname: 极光\nversion: 0.1.0\n",
		"内置名":    "id: tiles\nname: 极光\nversion: 0.1.0\nstyle: theme.css\n",
		"子目录脚本":  "id: aurora\nname: 极光\nversion: 0.1.0\nscript: dist/theme.js\n",
		"脚本类型不对": "id: aurora\nname: 极光\nversion: 0.1.0\nscript: theme.html\n",
		"未知字段":   "id: aurora\nname: 极光\nversion: 0.1.0\nstyle: theme.css\nhome: x\n",
		"规范太新":   "platform: 9\nid: aurora\nname: 极光\nversion: 0.1.0\nstyle: theme.css\n",
		"版本格式":   "id: aurora\nname: 极光\nversion: 1\nstyle: theme.css\n",
	} {
		if _, err := ParseTheme([]byte(yaml)); err == nil {
			t.Errorf("%s：应该报错", name)
		}
	}
}

func TestValidThemeAsset(t *testing.T) {
	for name, want := range map[string]bool{
		"assets/font.woff2":    true,
		"assets/img/bg.png":    true,
		"assets/../theme.yaml": false,
		"assets/.hidden.png":   false,
		"assets/run.sh":        false,
		"other/bg.png":         false,
		"assets//bg.png":       false,
	} {
		if got := ValidThemeAsset(name); got != want {
			t.Errorf("ValidThemeAsset(%q) = %v，应为 %v", name, got, want)
		}
	}
}
