package main

import (
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/Beane-Big/vibebooth/packages/manifest"
)

// 主题由安装器放在模块卷的 .themes/<id>/ 下。主题很少，每次请求直接读目录，不用像模块那样定时扫描。
func (s *Server) themesDir() string { return filepath.Join(s.registry.dir, ".themes") }

func (s *Server) themes() []*manifest.Theme {
	paths, _ := filepath.Glob(filepath.Join(s.themesDir(), "*", manifest.ThemeFile))
	list := []*manifest.Theme{}
	for _, p := range paths {
		dir := filepath.Base(filepath.Dir(p))
		if strings.HasPrefix(dir, ".") {
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if t, err := manifest.ParseTheme(data); err == nil && t.ID == dir {
			list = append(list, t)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list
}

// handleThemes 返回已安装的主题，所有登录的人都能看到，在“主题”应用里选用。
func (s *Server) handleThemes(w http.ResponseWriter, _ *http.Request, _ *User) {
	writeJSON(w, http.StatusOK, s.themes())
}

// Go 自带的类型表里没有字体。
var themeTypes = map[string]string{".woff": "font/woff", ".woff2": "font/woff2"}

// handleThemeFile 发主题的文件：清单里声明的脚本、样式、预览图，以及 assets/ 下的附带文件。
// 门户的网址带着版本号，这里允许浏览器缓存一会儿，升级主题后版本号变了会重新下载。
// 主题文件和门户同源：直接在浏览器里打开时（比如嵌了脚本的 SVG）不许运行脚本，否则不带脚本的主题能绕过安装时的确认。
// 门户用 <script>、<link>、<img> 加载这些文件时不受这个响应头影响。
func (s *Server) handleThemeFile(w http.ResponseWriter, r *http.Request, _ *User) {
	id, name := r.PathValue("id"), r.PathValue("path")
	var theme *manifest.Theme
	for _, t := range s.themes() {
		if t.ID == id {
			theme = t
		}
	}
	if theme == nil || !(manifest.ValidThemeAsset(name) || slices.Contains(theme.Files(), name)) {
		http.NotFound(w, r)
		return
	}
	file := filepath.Join(s.themesDir(), id, filepath.FromSlash(path.Clean("/"+name)))
	if ct := themeTypes[strings.ToLower(path.Ext(name))]; ct != "" {
		w.Header().Set("Content-Type", ct)
	} else if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'")
	w.Header().Set("Cache-Control", "private, max-age=300")
	http.ServeFile(w, r, file)
}

// 平台默认的皮肤：没有自己选过的人用它。值和门户的皮肤一样：classic、tiles 或 theme:<主题 id>。
const defaultSkinKey = "default_skin"

type appearance struct {
	DefaultSkin string `json:"defaultSkin"`
}

// validSkin 判断一个皮肤能不能用：内置的两种，或者已安装的主题。
func validSkin(skin string, themes []*manifest.Theme) bool {
	if skin == "classic" || skin == "tiles" {
		return true
	}
	id, ok := strings.CutPrefix(skin, "theme:")
	return ok && slices.ContainsFunc(themes, func(t *manifest.Theme) bool { return t.ID == id })
}

// handleAppearance 返回平台默认的皮肤。设成默认的主题被卸载了，或者从没设过，按经典皮肤。
func (s *Server) handleAppearance(w http.ResponseWriter, r *http.Request, _ *User) {
	skin, err := s.store.Setting(r.Context(), defaultSkinKey)
	if err != nil {
		internalError(w, err)
		return
	}
	if !validSkin(skin, s.themes()) {
		skin = "classic"
	}
	writeJSON(w, http.StatusOK, appearance{DefaultSkin: skin})
}

// handleSetAppearance 设置平台默认的皮肤，要有“应用管理”权限，和安装主题一样。
func (s *Server) handleSetAppearance(w http.ResponseWriter, r *http.Request, _ *User) {
	var req appearance
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validSkin(req.DefaultSkin, s.themes()) {
		writeError(w, http.StatusBadRequest, "没有这个皮肤")
		return
	}
	if err := s.store.SetSetting(r.Context(), defaultSkinKey, req.DefaultSkin); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, req)
}
