package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRegistryLoad(t *testing.T) {
	root := t.TempDir()
	write := func(dir, id string) {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
		yaml := "id: " + id + "\nname: 演示\nversion: 0.1.0\nservices:\n  backend: {port: 8000}\n"
		if err := os.WriteFile(filepath.Join(root, dir, "module.yaml"), []byte(yaml), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("demo", "demo")
	write("other", "demo")         // id 与目录名不一致
	write(".staging-next", "next") // 安装器暂存中的模块
	write("_template", "template") // 模板目录

	r := NewRegistry(root)
	r.Load()
	list := r.List()
	if len(list) != 1 || list[0].ID != "demo" {
		t.Fatalf("加载结果 = %v，只应有 demo", summary(r.modules))
	}
	if got := list[0].BackendURL() + list[0].HealthPath(); got != "http://demo-backend:8000/api/demo/health" {
		t.Errorf("健康检查地址 = %q", got)
	}

	// 安装器写入新模块后，下一次扫描就能发现它。
	write("next", "next")
	r.Load()
	if _, ok := r.Get("next"); !ok {
		t.Error("重新扫描后应发现 next")
	}
}
