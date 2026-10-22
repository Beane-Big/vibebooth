package main

import (
	"archive/tar"
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/Beane-Big/vibebooth/packages/manifest"
	"gopkg.in/yaml.v3"
)

// 模块包是一个 zip，根目录下只能有这几个文件（加上清单里声明的图标）。
const (
	manifestFile = "module.yaml"
	composeFile  = "compose.yaml"
	imagesFile   = "images.tar"
)

// invalidError 表示模块包不符合规范，HTTP 接口据此返回 400 而不是 500。
type invalidError struct{ msg string }

func (e *invalidError) Error() string { return e.msg }

func invalid(format string, args ...any) error { return &invalidError{fmt.Sprintf(format, args...)} }

// Package 是打开后的模块包。
type Package struct {
	Manifest     *manifest.Manifest
	ManifestData []byte
	Compose      []byte
	Icon         []byte
	images       *zip.File
	zip          *zip.ReadCloser
}

func (p *Package) Close() error { return p.zip.Close() }

// Images 返回 images.tar 的内容，用来交给 docker load。
func (p *Package) Images() (io.ReadCloser, error) { return p.images.Open() }

// OpenPackage 打开并校验模块包：文件清单、module.yaml、compose.yaml、镜像标签。
func OpenPackage(path string) (*Package, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, invalid("不是有效的 zip 文件: %v", err)
	}
	p := &Package{zip: zr}
	if err := p.load(); err != nil {
		zr.Close()
		return nil, err
	}
	return p, nil
}

func (p *Package) load() error {
	files := map[string]*zip.File{}
	for _, f := range p.zip.File {
		files[f.Name] = f
	}
	var err error
	if p.ManifestData, err = readSmall(files[manifestFile], 64<<10); err != nil {
		return invalid("%s: %v", manifestFile, err)
	}
	if p.Manifest, err = manifest.Parse(p.ManifestData); err != nil {
		return invalid("%v", err)
	}
	m := p.Manifest
	allowed := map[string]bool{manifestFile: true, composeFile: true, imagesFile: true}
	if m.Icon != "" {
		allowed[m.Icon] = true
		if p.Icon, err = readSmall(files[m.Icon], 256<<10); err != nil {
			return invalid("图标 %s: %v", m.Icon, err)
		}
	}
	for name := range files {
		if !allowed[name] {
			return invalid("模块包里不应有 %s，只能包含 module.yaml、compose.yaml、images.tar 和图标", name)
		}
	}
	if p.Compose, err = readSmall(files[composeFile], 64<<10); err != nil {
		return invalid("%s: %v", composeFile, err)
	}
	c, err := parseCompose(m, p.Compose)
	if err != nil {
		return err
	}
	if p.images = files[imagesFile]; p.images == nil {
		return invalid("缺少 %s", imagesFile)
	}
	r, err := p.images.Open()
	if err != nil {
		return invalid("%s: %v", imagesFile, err)
	}
	defer r.Close()
	return checkImageTags(r, c.images())
}

func readSmall(f *zip.File, limit int64) ([]byte, error) {
	if f == nil {
		return nil, errors.New("文件不存在")
	}
	if f.UncompressedSize64 > uint64(limit) {
		return nil, fmt.Errorf("文件超过 %d KB", limit>>10)
	}
	r, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, limit))
}

// ---- compose.yaml ----

// compose 只解析成通用结构：白名单之外的字段一律拒绝，生成最终文件时再补上网络和标签。
type compose struct {
	m        *manifest.Manifest
	services map[string]map[string]any
	volumes  map[string]any
}

// 模块 compose 里允许出现的服务字段。端口映射、特权、宿主机网络、挂载宿主机目录、标签等都不在其中。
var allowedServiceKeys = map[string]bool{
	"image": true, "environment": true, "command": true, "volumes": true,
	"depends_on": true, "healthcheck": true, "restart": true, "user": true,
}

var (
	serviceNamePattern = regexp.MustCompile(`^[a-z0-9]+$`)
	volumeNamePattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,40}$`)
	restartPolicies    = map[string]bool{"no": true, "always": true, "unless-stopped": true, "on-failure": true}
)

// imagePrefix 是模块镜像名的前缀；legacyImagePrefix 是改名为 Vibebooth 之前用的前缀，只在清理旧镜像时用到。
const (
	imagePrefix       = "vb-"
	legacyImagePrefix = "hp-"
)

// imageName 是服务必须使用的镜像名，例如 vb-family-backend:0.2.0。安装器只导入这些名字的镜像，
// 模块包不能借 docker load 覆盖平台或其他模块的镜像。
func imageName(m *manifest.Manifest, service string) string {
	return imagePrefix + service + ":" + m.Version
}

func parseCompose(m *manifest.Manifest, data []byte) (*compose, error) {
	var raw map[string]any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, invalid("compose.yaml 格式错误: %v", err)
	}
	c := &compose{m: m, services: map[string]map[string]any{}, volumes: map[string]any{}}
	for key, v := range raw {
		switch key {
		case "services":
			services, ok := v.(map[string]any)
			if !ok {
				return nil, invalid("compose.yaml: services 必须是映射")
			}
			for name, sv := range services {
				s, ok := sv.(map[string]any)
				if !ok {
					return nil, invalid("compose.yaml: 服务 %s 格式错误", name)
				}
				c.services[name] = s
			}
		case "volumes":
			if v == nil {
				continue
			}
			volumes, ok := v.(map[string]any)
			if !ok {
				return nil, invalid("compose.yaml: volumes 必须是映射")
			}
			for name, opts := range volumes {
				if !volumeNamePattern.MatchString(name) {
					return nil, invalid("compose.yaml: 卷名 %q 不合法", name)
				}
				// 只允许普通命名卷，不允许指定驱动、外部卷或自定义名字（否则可能挂到别的模块的卷）。
				if o, ok := opts.(map[string]any); opts != nil && (!ok || len(o) > 0) {
					return nil, invalid("compose.yaml: 卷 %s 不能带选项", name)
				}
				c.volumes[name] = nil
			}
		default:
			return nil, invalid("compose.yaml 顶层只能有 services 和 volumes，不能有 %s", key)
		}
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *compose) validate() error {
	m := c.m
	for svc := range m.Services {
		if _, ok := c.services[m.ContainerName(svc)]; !ok {
			return invalid("module.yaml 声明了 %s，compose.yaml 里必须有服务 %s", svc, m.ContainerName(svc))
		}
	}
	for name, s := range c.services {
		suffix, ok := strings.CutPrefix(name, m.ID+"-")
		if !ok || !serviceNamePattern.MatchString(suffix) {
			return invalid("服务名 %s 必须是 %s-<小写字母或数字>", name, m.ID)
		}
		for key := range s {
			if !allowedServiceKeys[key] {
				return invalid("服务 %s 不允许使用 %s", name, key)
			}
		}
		if img, _ := s["image"].(string); img != imageName(m, name) {
			return invalid("服务 %s 的 image 必须是 %s", name, imageName(m, name))
		}
		if err := checkEnv(name, s["environment"]); err != nil {
			return err
		}
		if err := c.checkVolumes(name, s["volumes"]); err != nil {
			return err
		}
		if err := c.checkDependsOn(name, s["depends_on"]); err != nil {
			return err
		}
		if r, ok := s["restart"]; ok {
			if r, _ := r.(string); !restartPolicies[r] {
				return invalid("服务 %s 的 restart 不合法", name)
			}
		}
	}
	// compose 会把 ${...} 替换成安装器进程的环境变量，可能泄露安装器的配置，所以整份文件都不允许出现 $。
	return checkNoDollar(c.services, "services")
}

// checkEnv 要求每个环境变量都写明取值：只写名字时 compose 会从安装器自己的环境里取值。
func checkEnv(service string, v any) error {
	switch e := v.(type) {
	case nil:
	case map[string]any:
		for k, val := range e {
			if val == nil {
				return invalid("服务 %s 的环境变量 %s 必须写明取值", service, k)
			}
		}
	case []any:
		for _, item := range e {
			if s, _ := item.(string); !strings.Contains(s, "=") {
				return invalid("服务 %s 的环境变量 %v 必须写成 名字=取值", service, item)
			}
		}
	default:
		return invalid("服务 %s 的 environment 格式错误", service)
	}
	return nil
}

func (c *compose) checkVolumes(service string, v any) error {
	if v == nil {
		return nil
	}
	list, ok := v.([]any)
	if !ok {
		return invalid("服务 %s 的 volumes 必须是列表", service)
	}
	for _, item := range list {
		s, ok := item.(string)
		if !ok {
			return invalid("服务 %s 的 volumes 只支持“卷名:容器内路径”的写法", service)
		}
		parts := strings.Split(s, ":")
		if len(parts) < 2 || len(parts) > 3 || (len(parts) == 3 && parts[2] != "ro" && parts[2] != "rw") {
			return invalid("服务 %s 的卷 %q 格式错误", service, s)
		}
		if _, ok := c.volumes[parts[0]]; !ok {
			return invalid("服务 %s 只能挂载本模块 volumes 里声明的卷，%q 不是", service, parts[0])
		}
		if !strings.HasPrefix(parts[1], "/") {
			return invalid("服务 %s 的卷 %q 容器内路径必须是绝对路径", service, s)
		}
	}
	return nil
}

func (c *compose) checkDependsOn(service string, v any) error {
	var names []string
	switch d := v.(type) {
	case nil:
	case []any:
		for _, n := range d {
			s, _ := n.(string)
			names = append(names, s)
		}
	case map[string]any:
		for n := range d {
			names = append(names, n)
		}
	default:
		return invalid("服务 %s 的 depends_on 格式错误", service)
	}
	for _, n := range names {
		if _, ok := c.services[n]; !ok {
			return invalid("服务 %s 只能依赖本模块的服务，%q 不是", service, n)
		}
	}
	return nil
}

func checkNoDollar(v any, path string) error {
	switch t := v.(type) {
	case string:
		if strings.Contains(t, "$") {
			return invalid("compose.yaml 的 %s 里不能出现 $", path)
		}
	case map[string]any:
		for k, item := range t {
			if err := checkNoDollar(item, path+"."+k); err != nil {
				return err
			}
		}
	case map[string]map[string]any:
		for k, item := range t {
			if err := checkNoDollar(item, path+"."+k); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range t {
			if err := checkNoDollar(item, path); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *compose) images() []string {
	var list []string
	for name := range c.services {
		list = append(list, imageName(c.m, name))
	}
	sort.Strings(list)
	return list
}

// Render 生成真正交给 docker compose 的文件：接入共享网络 platform，按约定补上网关路由标签和公钥地址。
// 网关路由由安装器生成，模块自己写不了，也就抢不走门户或别的模块的网址。
func (c *compose) Render() ([]byte, error) {
	m := c.m
	services := map[string]any{}
	for name, s := range c.services {
		out := map[string]any{}
		for k, v := range s {
			out[k] = v
		}
		if _, ok := out["restart"]; !ok {
			out["restart"] = "unless-stopped"
		}
		out["networks"] = []string{"platform"}
		out["environment"] = withEnv(out["environment"], "JWKS_URL", "http://core:8080/api/platform/.well-known/jwks.json")
		labels := []string{"home-platform.module=" + m.ID}
		switch name {
		case m.ContainerName(manifest.Frontend):
			labels = append(labels, routeLabels(m.ID+"-web", "PathPrefix(`"+m.FrontendPath()+"`)", m.Services[manifest.Frontend].Port)...)
		case m.ContainerName(manifest.Backend):
			// 对外接口 /api/<id>/ext/ 只给其他模块在内部网络里直接调用，网关不转发。
			rule := "PathPrefix(`" + m.APIPath() + "`) && !PathPrefix(`" + m.APIPath() + "ext/`)"
			labels = append(labels, routeLabels(m.ID+"-api", rule, m.Services[manifest.Backend].Port)...)
		}
		out["labels"] = labels
		services[name] = out
	}
	doc := map[string]any{
		"name":     projectName(m.ID),
		"services": services,
		"networks": map[string]any{"platform": map[string]any{"external": true, "name": "platform"}},
	}
	if len(c.volumes) > 0 {
		doc["volumes"] = c.volumes
	}
	return yaml.Marshal(doc)
}

func routeLabels(router, rule string, port int) []string {
	return []string{
		"traefik.enable=true",
		"traefik.http.routers." + router + ".rule=" + rule,
		"traefik.http.routers." + router + ".middlewares=platform-auth@docker",
		fmt.Sprintf("traefik.http.services.%s.loadbalancer.server.port=%d", router, port),
	}
}

// withEnv 在模块没有自己设置时补上一个环境变量，environment 可以是映射或列表。
func withEnv(env any, key, value string) any {
	switch e := env.(type) {
	case map[string]any:
		if _, ok := e[key]; !ok {
			e[key] = value
		}
		return e
	case []any:
		for _, item := range e {
			if s, _ := item.(string); strings.HasPrefix(s, key+"=") {
				return e
			}
		}
		return append(e, key+"="+value)
	default:
		return map[string]any{key: value}
	}
}

func projectName(id string) string { return "mod-" + id }

// ---- images.tar ----

// checkImageTags 读取 docker save 生成的 manifest.json，要求镜像标签和 compose 里用到的完全一致。
func checkImageTags(r io.Reader, want []string) error {
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return invalid("%s 里没有 manifest.json，请用 docker save 导出", imagesFile)
		}
		if err != nil {
			return invalid("%s 读取失败: %v", imagesFile, err)
		}
		if h.Name != "manifest.json" {
			continue
		}
		var entries []struct {
			RepoTags []string `json:"RepoTags"`
		}
		if err := json.NewDecoder(io.LimitReader(tr, 1<<20)).Decode(&entries); err != nil {
			return invalid("%s 的 manifest.json 格式错误: %v", imagesFile, err)
		}
		var got []string
		for _, e := range entries {
			for _, tag := range e.RepoTags {
				got = append(got, strings.TrimPrefix(tag, "docker.io/library/"))
			}
		}
		sort.Strings(got)
		if !slices.Equal(got, want) {
			return invalid("%s 里的镜像必须正好是 %s，实际是 %s", imagesFile, strings.Join(want, "、"), strings.Join(got, "、"))
		}
		return nil
	}
}
