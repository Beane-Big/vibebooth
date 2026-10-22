package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testManifest = "id: demo\nname: 演示\nversion: 0.2.0\nicon: icon.svg\nservices:\n  frontend: {port: 80}\n  backend: {port: 8000}\nmenus: [{id: home, name: 首页, path: /apps/demo/}]\n"

const testCompose = `services:
  demo-backend:
    image: hp-demo-backend:0.2.0
    environment:
      DATA_DIR: /data
    volumes:
      - demo-data:/data
  demo-frontend:
    image: hp-demo-frontend:0.2.0
    depends_on: [demo-backend]
volumes:
  demo-data:
`

var testTags = []string{"hp-demo-backend:0.2.0", "hp-demo-frontend:0.2.0"}

// imagesTar 生成一个只有 manifest.json 的假 images.tar，足够检查镜像标签。
func imagesTar(t *testing.T, tags ...string) []byte {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	var entries []map[string]any
	for _, tag := range tags {
		entries = append(entries, map[string]any{"RepoTags": []string{tag}})
	}
	data, _ := json.Marshal(entries)
	tw.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0o644, Size: int64(len(data))})
	tw.Write(data)
	tw.Close()
	return buf.Bytes()
}

func writePackage(t *testing.T, files map[string][]byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "demo.zip")
	var entries []zipEntry
	for name, data := range files {
		entries = append(entries, zipEntry{name: name, data: data})
	}
	if err := writeZip(path, entries); err != nil {
		t.Fatal(err)
	}
	return path
}

func validFiles(t *testing.T) map[string][]byte {
	return map[string][]byte{
		manifestFile: []byte(testManifest),
		composeFile:  []byte(testCompose),
		imagesFile:   imagesTar(t, testTags...),
		"icon.svg":   []byte("<svg/>"),
	}
}

func TestOpenPackageAndRender(t *testing.T) {
	pkg, err := OpenPackage(writePackage(t, validFiles(t)))
	if err != nil {
		t.Fatal(err)
	}
	defer pkg.Close()
	c, err := parseCompose(pkg.Manifest, pkg.Compose)
	if err != nil {
		t.Fatal(err)
	}
	out, err := c.Render()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"name: mod-demo",
		"traefik.http.routers.demo-web.rule=PathPrefix(`/apps/demo/`)",
		"traefik.http.routers.demo-api.rule=PathPrefix(`/api/demo/`) && !PathPrefix(`/api/demo/ext/`)",
		"traefik.http.routers.demo-api.middlewares=platform-auth@docker",
		"traefik.http.services.demo-api.loadbalancer.server.port=8000",
		"home-platform.module=demo",
		"JWKS_URL: http://core:8080/api/platform/.well-known/jwks.json",
		"external: true",
		"restart: unless-stopped",
	} {
		if !strings.Contains(string(out), want) {
			t.Errorf("生成的 compose 缺少 %q:\n%s", want, out)
		}
	}
}

func TestOpenPackageRejects(t *testing.T) {
	compose := func(old, new string) func(map[string][]byte) {
		return func(f map[string][]byte) {
			f[composeFile] = []byte(strings.Replace(testCompose, old, new, 1))
		}
	}
	backend := "    image: hp-demo-backend:0.2.0\n"
	cases := map[string]func(map[string][]byte){
		"多余文件":        func(f map[string][]byte) { f["run.sh"] = []byte("x") },
		"缺少镜像":        func(f map[string][]byte) { delete(f, imagesFile) },
		"缺少图标":        func(f map[string][]byte) { delete(f, "icon.svg") },
		"镜像标签多了":      func(f map[string][]byte) { f[imagesFile] = imagesTar(t, append(testTags, "traefik:v3.6")...) },
		"镜像标签少了":      func(f map[string][]byte) { f[imagesFile] = imagesTar(t, testTags[0]) },
		"端口映射":        compose(backend, backend+"    ports: [\"9000:8000\"]\n"),
		"特权模式":        compose(backend, backend+"    privileged: true\n"),
		"宿主机网络":       compose(backend, backend+"    network_mode: host\n"),
		"自己写标签":       compose(backend, backend+"    labels: [traefik.enable=true]\n"),
		"挂载宿主机目录":     compose("demo-data:/data", "/:/host"),
		"挂载未声明的卷":     compose("demo-data:/data", "other:/data"),
		"外部卷":         compose("volumes:\n  demo-data:\n", "volumes:\n  demo-data:\n    external: true\n"),
		"卷选项不是映射":     compose("volumes:\n  demo-data:\n", "volumes:\n  demo-data: local\n"),
		"镜像名不对":       compose("hp-demo-backend:0.2.0", "hp-demo-backend:latest"),
		"服务名不对":       compose("demo-frontend:\n", "web:\n"),
		"缺少后端服务":      compose("demo-backend:\n", "demo-api:\n"),
		"依赖别的模块":      compose("depends_on: [demo-backend]", "depends_on: [people-backend]"),
		"环境变量引用":      compose("DATA_DIR: /data", "DATA_DIR: ${HOME}"),
		"环境变量没写值":     compose("DATA_DIR: /data", "DOCKER_HOST:"),
		"顶层 networks": func(f map[string][]byte) { f[composeFile] = []byte(testCompose + "networks:\n  x: {}\n") },
		"清单不合法":       func(f map[string][]byte) { f[manifestFile] = []byte("id: demo\n") },
	}
	for name, mutate := range cases {
		files := validFiles(t)
		mutate(files)
		pkg, err := OpenPackage(writePackage(t, files))
		if err == nil {
			pkg.Close()
			t.Errorf("%s: 应该被拒绝", name)
			continue
		}
		var inv *invalidError
		if !errors.As(err, &inv) {
			t.Errorf("%s: 错误应该是 invalidError，实际是 %v", name, err)
		}
	}
}

func TestPack(t *testing.T) {
	dir := t.TempDir()
	devCompose := strings.ReplaceAll(testCompose, "0.2.0", "${VERSION}")
	devCompose = strings.Replace(devCompose, "    image: hp-demo-frontend:${VERSION}\n", "    image: hp-demo-frontend:${VERSION}\n    build: ./frontend\n", 1)
	files := map[string][]byte{manifestFile: []byte(testManifest), composeFile: []byte(devCompose), "icon.svg": []byte("<svg/>"), imagesFile: imagesTar(t, testTags...)}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	out := filepath.Join(dir, "demo-0.2.0.zip")
	if err := Pack(dir, filepath.Join(dir, imagesFile), out); err != nil {
		t.Fatal(err)
	}
	pkg, err := OpenPackage(out)
	if err != nil {
		t.Fatal(err)
	}
	defer pkg.Close()
	if strings.Contains(string(pkg.Compose), "build") || strings.Contains(string(pkg.Compose), "${VERSION}") {
		t.Errorf("打包后的 compose 应去掉 build 并写死版本号:\n%s", pkg.Compose)
	}
}
