package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// Module 对应每个模块目录下的 module.yaml。
type Module struct {
	ID          string   `yaml:"id"`
	Name        string   `yaml:"name"`
	Description string   `yaml:"description"`
	Icon        string   `yaml:"icon"`
	Version     string   `yaml:"version"`
	Frontend    string   `yaml:"frontend"`
	Backend     string   `yaml:"backend"`
	Health      string   `yaml:"health"`
	Roles       []string `yaml:"roles"`

	dir string
}

var moduleIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)

// 平台自己占用的路径前缀，模块不能用。
var reservedIDs = map[string]bool{"platform": true}

type Registry struct {
	dir     string
	mu      sync.RWMutex
	modules map[string]*Module
}

func NewRegistry(dir string) *Registry {
	return &Registry{dir: dir, modules: map[string]*Module{}}
}

// Load 扫描 modules/*/module.yaml；以 _ 开头的目录（如 _template）跳过。
func (r *Registry) Load() {
	paths, _ := filepath.Glob(filepath.Join(r.dir, "*", "module.yaml"))
	found := map[string]*Module{}
	for _, p := range paths {
		dir := filepath.Dir(p)
		if strings.HasPrefix(filepath.Base(dir), "_") {
			continue
		}
		m, err := readModule(p)
		if err != nil {
			slog.Warn("跳过无效模块", "path", p, "err", err)
			continue
		}
		if m.ID != filepath.Base(dir) {
			slog.Warn("跳过模块：id 必须与目录名一致", "path", p, "id", m.ID)
			continue
		}
		m.dir = dir
		found[m.ID] = m
	}
	r.mu.Lock()
	r.modules = found
	r.mu.Unlock()
	slog.Info("已加载模块", "count", len(found))
}

func readModule(path string) (*Module, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m Module
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	if !moduleIDPattern.MatchString(m.ID) || reservedIDs[m.ID] {
		return nil, errInvalid("id 只能是小写字母、数字和连字符，且不能是保留名")
	}
	if m.Name == "" {
		return nil, errInvalid("缺少 name")
	}
	if m.Frontend == "" {
		m.Frontend = "/apps/" + m.ID + "/"
	}
	if len(m.Roles) == 0 {
		m.Roles = []string{"user"}
	}
	return &m, nil
}

type errInvalid string

func (e errInvalid) Error() string { return string(e) }

func (r *Registry) Get(id string) (*Module, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok := r.modules[id]
	return m, ok
}

func (r *Registry) List() []*Module {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]*Module, 0, len(r.modules))
	for _, m := range r.modules {
		list = append(list, m)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list
}

type appView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`
	URL         string `json:"url"`
	Icon        string `json:"icon,omitempty"`
	Healthy     bool   `json:"healthy"`
}

// handleApps 返回当前用户有权限的应用，并并发检查各模块健康状态。
func (s *Server) handleApps(w http.ResponseWriter, r *http.Request, user *User) {
	var apps []*Module
	for _, m := range s.registry.List() {
		if hasAnyRole(user.Roles, m.Roles) {
			apps = append(apps, m)
		}
	}
	views := make([]appView, len(apps))
	var wg sync.WaitGroup
	for i, m := range apps {
		views[i] = appView{ID: m.ID, Name: m.Name, Description: m.Description, Version: m.Version, URL: m.Frontend}
		if m.Icon != "" {
			views[i].Icon = "/api/platform/apps/" + m.ID + "/icon"
		}
		wg.Add(1)
		go func(i int, m *Module) {
			defer wg.Done()
			views[i].Healthy = checkHealth(r.Context(), m)
		}(i, m)
	}
	wg.Wait()
	writeJSON(w, http.StatusOK, views)
}

var healthClient = &http.Client{Timeout: 1500 * time.Millisecond}

func checkHealth(ctx context.Context, m *Module) bool {
	if m.Backend == "" || m.Health == "" {
		return true
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(m.Backend, "/")+m.Health, nil)
	if err != nil {
		return false
	}
	resp, err := healthClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode < 300
}

var iconTypes = map[string]string{".svg": "image/svg+xml", ".png": "image/png"}

func (s *Server) handleAppIcon(w http.ResponseWriter, r *http.Request, user *User) {
	m, ok := s.registry.Get(r.PathValue("id"))
	if !ok || m.Icon == "" || !hasAnyRole(user.Roles, m.Roles) {
		http.NotFound(w, r)
		return
	}
	// 图标路径必须留在模块目录内。
	path := filepath.Join(m.dir, filepath.Clean("/"+m.Icon))
	contentType, ok := iconTypes[strings.ToLower(filepath.Ext(path))]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	// SVG 可能带脚本，禁止它在浏览器里执行。
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("Cache-Control", "private, max-age=300")
	http.ServeFile(w, r, path)
}

func (s *Server) handleReload(w http.ResponseWriter, _ *http.Request, _ *User) {
	s.registry.Load()
	writeJSON(w, http.StatusOK, map[string]int{"count": len(s.registry.List())})
}
