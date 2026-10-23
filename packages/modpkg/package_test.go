package modpkg

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Beane-Big/vibebooth/packages/manifest"
	"gopkg.in/yaml.v3"
)

const testManifest = "id: demo\nname: 演示\nversion: 0.2.0\nicon: icon.svg\nservices:\n  frontend: {port: 80}\n  backend: {port: 8000}\nmenus: [{id: home, name: 首页, path: /apps/demo/}]\n"

const testCompose = `services:
  demo-backend:
    image: vb-demo-backend:0.2.0
    environment:
      DATA_DIR: /data
    volumes:
      - demo-data:/data
  demo-frontend:
    image: vb-demo-frontend:0.2.0
    depends_on: [demo-backend]
volumes:
  demo-data:
`

// testDevCompose 是模块仓库里开发用的 compose.yaml。
const testDevCompose = `services:
  demo-backend:
    image: vb-demo-backend:${VERSION}
    build: ./backend
    environment:
      DATA_DIR: /data
    volumes:
      - demo-data:/data
  demo-frontend:
    image: vb-demo-frontend:${VERSION}
    build: {context: frontend, dockerfile: docker/prod.Dockerfile}
    depends_on: [demo-backend]
volumes:
  demo-data:
`

var testTags = []string{"vb-demo-backend:0.2.0", "vb-demo-frontend:0.2.0"}

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
		ManifestFile: []byte(testManifest),
		ComposeFile:  []byte(testCompose),
		ImagesFile:   imagesTar(t, testTags...),
		"icon.svg":   []byte("<svg/>"),
	}
}

func TestOpenPackageAndRender(t *testing.T) {
	pkg, err := OpenPackage(writePackage(t, validFiles(t)))
	if err != nil {
		t.Fatal(err)
	}
	defer pkg.Close()
	c, err := ParseCompose(pkg.Manifest, pkg.Compose)
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
			f[ComposeFile] = []byte(strings.Replace(testCompose, old, new, 1))
		}
	}
	backend := "    image: vb-demo-backend:0.2.0\n"
	cases := map[string]func(map[string][]byte){
		"多余文件":        func(f map[string][]byte) { f["run.sh"] = []byte("x") },
		"缺少镜像":        func(f map[string][]byte) { delete(f, ImagesFile) },
		"缺少图标":        func(f map[string][]byte) { delete(f, "icon.svg") },
		"镜像标签多了":      func(f map[string][]byte) { f[ImagesFile] = imagesTar(t, append(testTags, "traefik:v3.6")...) },
		"镜像标签少了":      func(f map[string][]byte) { f[ImagesFile] = imagesTar(t, testTags[0]) },
		"端口映射":        compose(backend, backend+"    ports: [\"9000:8000\"]\n"),
		"特权模式":        compose(backend, backend+"    privileged: true\n"),
		"宿主机网络":       compose(backend, backend+"    network_mode: host\n"),
		"自己写标签":       compose(backend, backend+"    labels: [traefik.enable=true]\n"),
		"挂载宿主机目录":     compose("demo-data:/data", "/:/host"),
		"挂载未声明的卷":     compose("demo-data:/data", "other:/data"),
		"外部卷":         compose("volumes:\n  demo-data:\n", "volumes:\n  demo-data:\n    external: true\n"),
		"卷选项不是映射":     compose("volumes:\n  demo-data:\n", "volumes:\n  demo-data: local\n"),
		"镜像名不对":       compose("vb-demo-backend:0.2.0", "vb-demo-backend:latest"),
		"旧的镜像前缀":      compose("vb-demo-backend:0.2.0", "hp-demo-backend:0.2.0"),
		"服务名不对":       compose("demo-frontend:\n", "web:\n"),
		"缺少后端服务":      compose("demo-backend:\n", "demo-api:\n"),
		"依赖别的模块":      compose("depends_on: [demo-backend]", "depends_on: [people-backend]"),
		"环境变量引用":      compose("DATA_DIR: /data", "DATA_DIR: ${HOME}"),
		"环境变量没写值":     compose("DATA_DIR: /data", "DOCKER_HOST:"),
		"顶层 networks": func(f map[string][]byte) { f[ComposeFile] = []byte(testCompose + "networks:\n  x: {}\n") },
		"清单不合法":       func(f map[string][]byte) { f[ManifestFile] = []byte("id: demo\n") },
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
		var inv *InvalidError
		if !errors.As(err, &inv) {
			t.Errorf("%s: 错误应该是 InvalidError，实际是 %v", name, err)
		}
	}
}

func TestPack(t *testing.T) {
	dir := t.TempDir()
	files := map[string][]byte{ManifestFile: []byte(testManifest), ComposeFile: []byte(testDevCompose), "icon.svg": []byte("<svg/>"), ImagesFile: imagesTar(t, testTags...)}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	out := filepath.Join(dir, "demo-0.2.0.zip")
	if err := Pack(dir, filepath.Join(dir, ImagesFile), out); err != nil {
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

func TestDevCompose(t *testing.T) {
	m, err := manifest.Parse([]byte(testManifest))
	if err != nil {
		t.Fatal(err)
	}
	release, targets, err := DevCompose(m, []byte(testDevCompose))
	if err != nil {
		t.Fatal(err)
	}
	want := []BuildTarget{
		{Service: "demo-backend", Image: "vb-demo-backend:0.2.0", Context: "backend", Dockerfile: "Dockerfile"},
		{Service: "demo-frontend", Image: "vb-demo-frontend:0.2.0", Context: "frontend", Dockerfile: "docker/prod.Dockerfile"},
	}
	if !slices.Equal(targets, want) {
		t.Errorf("targets = %v", targets)
	}
	if strings.Contains(string(release), "build") || strings.Contains(string(release), "${VERSION}") {
		t.Errorf("转换后的 compose 应去掉 build 并写死版本号:\n%s", release)
	}

	cases := map[string][2]string{
		"缺 build":       {"    build: ./backend\n", ""},
		"绝对路径":          {"build: ./backend", "build: /etc"},
		"跳出仓库":          {"build: ./backend", "build: ../other"},
		"远程上下文":         {"build: ./backend", "build: https://github.com/x/y.git"},
		"build 其他字段":    {"build: ./backend", "build: {context: ./backend, args: {A: b}}"},
		"dockerfile 跳出": {"build: ./backend", "build: {context: ./backend, dockerfile: ../Dockerfile}"},
		"镜像名不对":         {"vb-demo-backend:${VERSION}", "vb-other:${VERSION}"},
	}
	for name, c := range cases {
		data := strings.Replace(testDevCompose, c[0], c[1], 1)
		if _, _, err := DevCompose(m, []byte(data)); err == nil {
			t.Errorf("%s: 应该被拒绝", name)
		}
	}
}

func TestRenderBuildPrivilege(t *testing.T) {
	m, err := manifest.Parse([]byte(testManifest + "privileges: [docker-build]\n"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := ParseCompose(m, []byte(strings.Replace(testCompose, "DATA_DIR: /data", "DATA_DIR: /data\n      DOCKER_HOST: tcp://evil:2375", 1)))
	if err != nil {
		t.Fatal(err)
	}
	out, err := c.Render()
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Services map[string]struct {
			Networks    []string          `yaml:"networks"`
			Environment map[string]string `yaml:"environment"`
		} `yaml:"services"`
		Networks map[string]map[string]any `yaml:"networks"`
	}
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	backend, frontend := doc.Services["demo-backend"], doc.Services["demo-frontend"]
	if !slices.Contains(backend.Networks, BuildNetwork) || backend.Environment["DOCKER_HOST"] != BuildProxyHost {
		t.Errorf("后端应接上构建网络并使用平台的 DOCKER_HOST：%+v", backend)
	}
	if slices.Contains(frontend.Networks, BuildNetwork) {
		t.Error("前端不应接上构建网络")
	}
	if doc.Networks[BuildNetwork]["external"] != true {
		t.Errorf("构建网络应声明为外部网络：%v", doc.Networks)
	}
}
