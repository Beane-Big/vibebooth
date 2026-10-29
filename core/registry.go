package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Beane-Big/vibebooth/packages/manifest"
)

// Module 是一个已安装的模块：清单内容加上它在模块卷里的目录（图标从这里读）。
type Module struct {
	*manifest.Manifest
	dir string
	// 图标拆成的底色和图形，拆不了时为 nil。
	layers *iconLayers
}

type Registry struct {
	dir     string
	mu      sync.RWMutex
	modules map[string]*Module
}

func NewRegistry(dir string) *Registry {
	return &Registry{dir: dir, modules: map[string]*Module{}}
}

// Load 扫描模块卷里的 */module.yaml。以 _ 或 . 开头的目录跳过，安装器用 . 开头的目录暂存安装中的模块。
func (r *Registry) Load() {
	paths, _ := filepath.Glob(filepath.Join(r.dir, "*", "module.yaml"))
	found := map[string]*Module{}
	for _, p := range paths {
		dir := filepath.Dir(p)
		if strings.HasPrefix(filepath.Base(dir), "_") || strings.HasPrefix(filepath.Base(dir), ".") {
			continue
		}
		data, err := os.ReadFile(p)
		if err == nil {
			var m *manifest.Manifest
			if m, err = manifest.Parse(data); err == nil {
				if m.ID != filepath.Base(dir) {
					slog.Warn("跳过模块：id 必须与目录名一致", "path", p, "id", m.ID)
					continue
				}
				found[m.ID] = &Module{Manifest: m, dir: dir, layers: loadLayers(dir, m.Icon)}
				continue
			}
		}
		slog.Warn("跳过无效模块", "path", p, "err", err)
	}
	r.mu.Lock()
	changed := summary(r.modules) != summary(found)
	r.modules = found
	r.mu.Unlock()
	if changed {
		slog.Info("已加载模块", "count", len(found), "modules", summary(found))
	}
}

// Watch 定期重新扫描，安装器装好或卸载模块后，门户和网关几秒内就能认出来，不用重启平台核心。
func (r *Registry) Watch(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.Load()
		}
	}
}

// summary 用于判断模块列表是否有变化，例如 "contacts@0.2.0 notes@0.1.0"。
func summary(modules map[string]*Module) string {
	items := make([]string, 0, len(modules))
	for id, m := range modules {
		items = append(items, id+"@"+m.Version)
	}
	sort.Strings(items)
	return strings.Join(items, " ")
}

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
	// 图标能拆成底色和图形时才有：Glyph 是图形的网址，Color 是底色。
	Glyph   string `json:"glyph,omitempty"`
	Color   string `json:"color,omitempty"`
	Healthy bool   `json:"healthy"`
}

// handleApps 返回当前用户能用的应用（应用开关开着就有入口，里面能看哪些页面另按菜单算），并并发检查各模块健康状态。
func (s *Server) handleApps(w http.ResponseWriter, r *http.Request, user *User) {
	g, err := s.store.Grants(r.Context(), user.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	var apps []*Module
	for _, m := range s.registry.List() {
		if appAllowed(user, m, g) {
			apps = append(apps, m)
		}
	}
	views := make([]appView, len(apps))
	var wg sync.WaitGroup
	for i, m := range apps {
		views[i] = appView{ID: m.ID, Name: m.Name, Description: m.Description, Version: m.Version, URL: m.FrontendPath()}
		if m.Icon != "" {
			views[i].Icon = "/api/platform/apps/" + m.ID + "/icon"
		}
		if m.layers != nil {
			views[i].Glyph = "/api/platform/apps/" + m.ID + "/glyph"
			views[i].Color = m.layers.color
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
	if m.BackendURL() == "" {
		return true
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.BackendURL()+m.HealthPath(), nil)
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

// iconPath 是模块图标在模块目录里的路径，不是 .svg、.png 时为空。图标路径必须留在模块目录内。
func iconPath(dir, icon string) (path, contentType string) {
	path = filepath.Join(dir, filepath.Clean("/"+icon))
	contentType, ok := iconTypes[strings.ToLower(filepath.Ext(path))]
	if !ok {
		return "", ""
	}
	return path, contentType
}

// loadLayers 读模块的 SVG 图标并拆成底色和图形，见 splitIcon。
func loadLayers(dir, icon string) *iconLayers {
	if icon == "" {
		return nil
	}
	path, contentType := iconPath(dir, icon)
	if contentType != "image/svg+xml" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return splitIcon(data)
}

// iconModule 返回当前用户能用的模块，没有或没权限时回 404。
func (s *Server) iconModule(w http.ResponseWriter, r *http.Request, user *User) (*Module, bool) {
	m, ok := s.registry.Get(r.PathValue("id"))
	if !ok || m.Icon == "" {
		http.NotFound(w, r)
		return nil, false
	}
	g, err := s.store.Grants(r.Context(), user.ID)
	if err != nil {
		internalError(w, err)
		return nil, false
	}
	if !appAllowed(user, m, g) {
		http.NotFound(w, r)
		return nil, false
	}
	return m, true
}

// iconHeaders 是发图标时的响应头。SVG 可能带脚本，禁止它在浏览器里执行。
func iconHeaders(w http.ResponseWriter, contentType string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("Cache-Control", "private, max-age=300")
}

func (s *Server) handleAppIcon(w http.ResponseWriter, r *http.Request, user *User) {
	m, ok := s.iconModule(w, r, user)
	if !ok {
		return
	}
	path, contentType := iconPath(m.dir, m.Icon)
	if path == "" {
		http.NotFound(w, r)
		return
	}
	iconHeaders(w, contentType)
	http.ServeFile(w, r, path)
}

// handleAppGlyph 发图标去掉底色后的图形，门户拿它当蒙版给图标换颜色。
func (s *Server) handleAppGlyph(w http.ResponseWriter, r *http.Request, user *User) {
	m, ok := s.iconModule(w, r, user)
	if !ok {
		return
	}
	if m.layers == nil {
		http.NotFound(w, r)
		return
	}
	iconHeaders(w, "image/svg+xml")
	w.Write(m.layers.glyph)
}

func (s *Server) handleReload(w http.ResponseWriter, _ *http.Request, _ *User) {
	s.registry.Load()
	writeJSON(w, http.StatusOK, map[string]int{"count": len(s.registry.List())})
}
