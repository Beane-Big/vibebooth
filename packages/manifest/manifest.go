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
	"slices"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// SupportedPlatform 是这个版本的平台支持的最高模块规范版本，对应 module.yaml 里的 platform。
// 只有规则收紧、老的模块包会装不上时才加 1；新增可选字段不加。
const SupportedPlatform = 1

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
	// Settings 已不再使用：模块的设置入口由模块自己放在页面上。保留这个字段，旧清单照样能装。
	Settings bool `yaml:"settings" json:"-"`
}

// Requirement 是 requires 里的一项：依赖的模块 id 和要求的最低版本（为空表示任何版本都行）。
type Requirement struct {
	ID  string
	Min string
}

// SatisfiedBy 判断已安装的版本是否满足要求。
func (r Requirement) SatisfiedBy(version string) bool {
	return r.Min == "" || CompareVersions(version, r.Min) >= 0
}

func (r Requirement) String() string {
	if r.Min == "" {
		return r.ID
	}
	return r.ID + " " + r.Min + " 以上"
}

// Manifest 对应模块包里的 module.yaml。
type Manifest struct {
	// Platform 是模块遵循的规范版本，不填为 1。比平台支持的版本高时拒绝安装。
	Platform    int                `yaml:"platform"`
	ID          string             `yaml:"id"`
	Name        string             `yaml:"name"`
	Description string             `yaml:"description"`
	Icon        string             `yaml:"icon"`
	Version     string             `yaml:"version"`
	Services    map[string]Service `yaml:"services"`
	// Requires 是本模块要调用的其他模块，写成 contacts 或 contacts>=0.2。没装或版本不够就不能安装，
	// 被依赖的模块不能先卸载。解析结果在 Deps 里。
	Requires []string `yaml:"requires"`
	// Optional 是可选依赖，写法同 requires：没装也能安装，模块自己处理对方不在的情况；
	// 装了就必须满足版本要求，否则对方的接口可能不存在。卸载对方不受影响。解析结果在 OptionalDeps 里。
	Optional []string `yaml:"optional"`
	// Privileges 是模块需要的平台特权，安装时要管理员单独确认，取值见 Privilege 常量。
	Privileges []string `yaml:"privileges"`
	Menus      []Menu   `yaml:"menus"`

	Deps         []Requirement `yaml:"-"`
	OptionalDeps []Requirement `yaml:"-"`
}

// PrivilegeDockerBuild 允许模块后端经过平台的构建代理在服务器上构建镜像。代理只放行名字以 vb- 开头的模块镜像，
// 碰不到平台自己的镜像和容器，但能替换其他模块的镜像，所以安装前要管理员确认。
const PrivilegeDockerBuild = "docker-build"

var privileges = map[string]bool{PrivilegeDockerBuild: true}

var (
	idPattern      = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)
	menuIDPattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}$`)
	versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	// requires 里的一项：id，或 id>=x.y / id>=x.y.z。
	requirePattern = regexp.MustCompile(`^([a-z][a-z0-9-]{1,30})(?:>=(\d+\.\d+(?:\.\d+)?))?$`)
	// 平台自己的路径前缀和服务名，模块不能用，否则会抢走平台的路由或在内部网络里重名。
	reservedIDs = map[string]bool{
		"platform": true, "core": true, "portal": true, "traefik": true,
		"postgres": true, "socket": true, "installer": true, "build": true,
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
	if m.Platform == 0 {
		m.Platform = 1
	}
	if m.Platform < 0 {
		return errors.New("platform 必须是正整数")
	}
	if m.Platform > SupportedPlatform {
		return fmt.Errorf("这个模块需要平台规范 %d，当前平台只支持到 %d，请先升级平台", m.Platform, SupportedPlatform)
	}
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
	var err error
	if m.Deps, err = m.parseDeps("requires", m.Requires); err != nil {
		return err
	}
	if m.OptionalDeps, err = m.parseDeps("optional", m.Optional); err != nil {
		return err
	}
	for _, d := range m.OptionalDeps {
		if slices.Contains(m.RequiredIDs(), d.ID) {
			return fmt.Errorf("%s 不能同时写在 requires 和 optional 里", d.ID)
		}
	}
	for _, p := range m.Privileges {
		if !privileges[p] {
			return fmt.Errorf("privileges 里的 %q 不认识，目前只支持 %s", p, PrivilegeDockerBuild)
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

// parseDeps 解析 requires 或 optional 的每一项，x.y 补成 x.y.0。
func (m *Manifest) parseDeps(field string, list []string) ([]Requirement, error) {
	var deps []Requirement
	for _, r := range list {
		match := requirePattern.FindStringSubmatch(strings.ReplaceAll(r, " ", ""))
		if match == nil || !ValidID(match[1]) || match[1] == m.ID {
			return nil, fmt.Errorf("%s 里的 %q 不合法，要写成其他模块的 id，例如 contacts 或 contacts>=0.2", field, r)
		}
		min := match[2]
		if strings.Count(min, ".") == 1 {
			min += ".0"
		}
		deps = append(deps, Requirement{ID: match[1], Min: min})
	}
	return deps, nil
}

// HasPrivilege 判断模块是否声明了某项特权。
func (m *Manifest) HasPrivilege(p string) bool { return slices.Contains(m.Privileges, p) }

// RequiredIDs 返回依赖的模块 id。
func (m *Manifest) RequiredIDs() []string {
	ids := make([]string, 0, len(m.Deps))
	for _, d := range m.Deps {
		ids = append(ids, d.ID)
	}
	return ids
}

// CompareVersions 比较两个 x.y.z 版本号，a 小于、等于、大于 b 时分别返回 -1、0、1。
func CompareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		x, _ := strconv.Atoi(pa[i])
		y, _ := strconv.Atoi(pb[i])
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
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

// ContainerName 是服务在内部网络里的名字，例如 notes-backend。
func (m *Manifest) ContainerName(service string) string { return m.ID + "-" + service }

// BackendURL 是内部网络里访问后端的地址；没有后端时返回空字符串。
func (m *Manifest) BackendURL() string {
	s, ok := m.Services[Backend]
	if !ok {
		return ""
	}
	return fmt.Sprintf("http://%s:%d", m.ContainerName(Backend), s.Port)
}
