package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadModuleSettings(t *testing.T) {
	cases := map[string]bool{
		"":                      true,
		"/apps/demo/settings":   true,
		"/apps/other/settings":  false,
		"/apps/demo/../other/":  false,
		"https://example.com/x": false,
	}
	for settings, ok := range cases {
		path := filepath.Join(t.TempDir(), "module.yaml")
		yaml := "id: demo\nname: 演示\nsettings: \"" + settings + "\"\n"
		if err := os.WriteFile(path, []byte(yaml), 0o600); err != nil {
			t.Fatal(err)
		}
		m, err := readModule(path)
		if (err == nil) != ok {
			t.Errorf("settings %q: err = %v, want ok = %v", settings, err, ok)
			continue
		}
		if ok && (len(m.SettingsRoles) != 1 || m.SettingsRoles[0] != "admin") {
			t.Errorf("settings %q: SettingsRoles = %v, want [admin]", settings, m.SettingsRoles)
		}
	}
}
