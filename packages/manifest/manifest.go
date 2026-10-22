// Package manifest 解析和校验模块清单 module.yaml。
//
// 平台核心和安装器共用这一份规则，保证安装器接受的清单平台核心一定也认。
package manifest

import (
	"bytes"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// 模块对外的两种服务，容器名固定为 <id>-frontend 和 <id>-backend。
const (
	Frontend = "frontend"
	Backend  = "backend"
)

// Service 是 services 下的一项：容器监听的端口。
type Service struct {
	Port int `yaml:"port"`
}

// Menu 是模块的一个页面。门户按人控制谁能看到哪些菜单，网关按菜单拦截页面。
type Menu struct {
	ID   string `yaml:"id" json:"id"`
	Name string `yaml:"name" json:"name"`
	Path string `yaml:"path" json:"path"`
	// Default 是默认拥有这个菜单的角色，不填为 [user]。管理员可以对单个人勾选或取消，覆盖默认值。
	Default []string `yaml:"default" json:"-"`
	// Settings 为 true 时，这个菜单同时出现在门户的“设置”页。
	Settings bool `yaml:"settings" json:"-"`
}

// Manifest 对应模块包里的 module.yaml。
type Manifest struct {
	ID          string             `yaml:"id"`
	Name        string             `yaml:"name"`
	Description string             `yaml:"description"`
	Icon        string             `yaml:"icon"`
	Version     string             `yaml:"version"`
	Services    map[string]Service `yaml:"services"`
	// Requires 是本模块要调用的其他模块，没装就不能安装，被依赖的模块不能先卸载。
	Requires []string `yaml:"requires"`
	Menus    []Menu   `yaml:"menus"`
}

var (
	idPattern      = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)
	menuIDPattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}$`)
	versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	// 平台自己的路径前缀和服务名，模块不能用，否则会抢走平台的路由或在内部网络里重名。
	reservedIDs = map[string]bool{
		"platform": true, "core": true, "portal": true, "traefik": true,
		"postgres": true, "socket": true, "installer": true,
	}
	iconTypes = map[string]bool{".svg": true, ".png": true}
)

// ValidID 判断模块 id 是否合法。
func ValidID(id string) bool {
	return idPattern.MatchString(id) && !reservedIDs[id]
}

// Parse 解析并校验清单，同时补上默认值。未知字段视为错误，避免拼错的字段被悄悄忽略。
func Parse(data []byte) (*Manifest, error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("module.yaml 格式错误: %w", err)
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

func (m *Manifest) validate() error {
	if !ValidID(m.ID) {
		return errors.New("id 只能是小写字母开头的小写字母、数字和连字符，且不能是保留名")
	}
	if m.Name == "" {
		return errors.New("缺少 name")
	}
	if !versionPattern.MatchString(m.Version) {
		return errors.New("version 必须是 x.y.z 形式，例如 0.1.0")
	}
	if m.Icon != "" && (m.Icon != filepath.Base(m.Icon) || !iconTypes[strings.ToLower(filepath.Ext(m.Icon))]) {
		return errors.New("icon 只能是模块包根目录下的 .svg 或 .png 文件")
	}
	if len(m.Services) == 0 {
		return errors.New("services 里至少要有 frontend 或 backend")
	}
	for name, s := range m.Services {
		if name != Frontend && name != Backend {
			return fmt.Errorf("services 只能是 frontend 和 backend，不认识 %q", name)
		}
		if s.Port < 1 || s.Port > 65535 {
			return fmt.Errorf("services.%s.port 必须在 1 到 65535 之间", name)
		}
	}
	for _, r := range m.Requires {
		if !ValidID(r) || r == m.ID {
			return fmt.Errorf("requires 里的 %q 不是合法的其他模块 id", r)
		}
	}
	_, hasFrontend := m.Services[Frontend]
	if hasFrontend && len(m.Menus) == 0 {
		return errors.New("有 frontend 时至少要声明一个菜单（menus）")
	}
	ids, paths := map[string]bool{}, map[string]bool{}
	for i := range m.Menus {
		menu := &m.Menus[i]
		if !hasFrontend {
			return errors.New("有 menus 时必须有 frontend 服务")
		}
		if !menuIDPattern.MatchString(menu.ID) || ids[menu.ID] {
			return fmt.Errorf("菜单 id %q 不合法或重复", menu.ID)
		}
		if menu.Name == "" {
			return fmt.Errorf("菜单 %s 缺少 name", menu.ID)
		}
		// 菜单必须在模块自己的前端路径下，防止清单把入口指向别的模块或外部网站。
		if !strings.HasPrefix(menu.Path, m.FrontendPath()) || strings.Contains(menu.Path, "..") || paths[menu.Path] {
			return fmt.Errorf("菜单 %s 的 path 必须以 %s 开头且不能重复", menu.ID, m.FrontendPath())
		}
		if len(menu.Default) == 0 {
			menu.Default = []string{"user"}
		}
		ids[menu.ID], paths[menu.Path] = true, true
	}
	return nil
}

// MenuFor 返回网址路径（不含查询参数）所属的菜单：路径前缀最长的那一个；不在任何菜单下时返回 nil。
// 菜单 /apps/x/settings/ 也管 /apps/x/settings 这种不带末尾斜杠的写法，免得绕过页面拦截。
func (m *Manifest) MenuFor(path string) *Menu {
	var found *Menu
	for i := range m.Menus {
		menu := &m.Menus[i]
		dir := strings.TrimSuffix(menu.Path, "/")
		inMenu := path == dir || strings.HasPrefix(path, dir+"/")
		if inMenu && (found == nil || len(menu.Path) > len(found.Path)) {
			found = menu
		}
	}
	return found
}

// MenuByID 按 id 找菜单，找不到时返回 nil。
func (m *Manifest) MenuByID(id string) *Menu {
	for i := range m.Menus {
		if m.Menus[i].ID == id {
			return &m.Menus[i]
		}
	}
	return nil
}

// FrontendPath 是模块前端的网址前缀，也是门户卡片跳转的地址。
func (m *Manifest) FrontendPath() string { return "/apps/" + m.ID + "/" }

// APIPath 是模块后端的网址前缀。
func (m *Manifest) APIPath() string { return "/api/" + m.ID + "/" }

// HealthPath 是后端的健康检查接口，平台核心和安装器在内部网络直接调用。
func (m *Manifest) HealthPath() string { return m.APIPath() + "health" }

// ContainerName 是服务在内部网络里的名字，例如 family-backend。
func (m *Manifest) ContainerName(service string) string { return m.ID + "-" + service }

// BackendURL 是内部网络里访问后端的地址；没有后端时返回空字符串。
func (m *Manifest) BackendURL() string {
	s, ok := m.Services[Backend]
	if !ok {
		return ""
	}
	return fmt.Sprintf("http://%s:%d", m.ContainerName(Backend), s.Port)
}
