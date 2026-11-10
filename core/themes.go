package main

import (
	"archive/zip"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
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

// handleExportTheme 把一个已安装的主题打成主题包（zip）下载，要有“应用管理”权限，和安装、卸载一样。
// 包里是 theme.yaml、它声明的脚本、样式、预览图和 assets/ 下的文件，和安装时上传的包一样，能直接装到别的平台上。
// 主题源码丢了的时候，靠它把装在平台上的版本拿回来。
func (s *Server) handleExportTheme(w http.ResponseWriter, r *http.Request, _ *User) {
	id := r.PathValue("id")
	themes := s.themes()
	i := slices.IndexFunc(themes, func(t *manifest.Theme) bool { return t.ID == id })
	if i < 0 {
		writeError(w, http.StatusNotFound, "没有安装这个主题")
		return
	}
	theme := themes[i]
	root := filepath.Join(s.themesDir(), id)
	// 先列出要打包的文件，出错时还能返回错误；开始写 zip 以后响应头已经发出去了。
	files := []string{manifest.ThemeFile}
	files = append(files, theme.Files()...)
	err := filepath.WalkDir(filepath.Join(root, manifest.ThemeAssetsDir), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		rel, _ := filepath.Rel(root, p)
		if name := filepath.ToSlash(rel); d.Type().IsRegular() && manifest.ValidThemeAsset(name) {
			files = append(files, name)
		}
		return nil
	})
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-%s.zip"`, theme.ID, theme.Version))
	zw := zip.NewWriter(w)
	for _, name := range files {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
		if err == nil {
			var f io.Writer
			if f, err = zw.Create(name); err == nil {
				_, err = f.Write(data)
			}
		}
		if err != nil {
			// 响应已经开始了，只能中断；浏览器会提示下载失败。
			slog.Warn("导出主题失败", "theme", id, "err", err)
			panic(http.ErrAbortHandler)
		}
	}
	zw.Close()
}

// 平台默认的皮肤：没有自己选过的人用它。值和门户的皮肤一样：classic、tiles 或 theme:<主题 id>。
const defaultSkinKey = "default_skin"

// 平台默认的壁纸：没有自己选过的人用它。值是壁纸 id（见 wallpapers.go），空表示不用壁纸。
const defaultWallpaperKey = "default_wallpaper"

type appearance struct {
	DefaultSkin      string `json:"defaultSkin"`
	DefaultWallpaper string `json:"defaultWallpaper"`
}

// validSkin 判断一个皮肤能不能用：内置的两种，或者已安装的主题。
func validSkin(skin string, themes []*manifest.Theme) bool {
	if skin == "classic" || skin == "tiles" {
		return true
	}
	id, ok := strings.CutPrefix(skin, "theme:")
	return ok && slices.ContainsFunc(themes, func(t *manifest.Theme) bool { return t.ID == id })
}

// handleAppearance 返回平台默认的皮肤和壁纸。设成默认的主题被卸载了，或者从没设过，按经典皮肤；
// 默认壁纸被删了时按不用壁纸。
func (s *Server) handleAppearance(w http.ResponseWriter, r *http.Request, _ *User) {
	skin, err := s.store.Setting(r.Context(), defaultSkinKey)
	if err != nil {
		internalError(w, err)
		return
	}
	if !validSkin(skin, s.themes()) {
		skin = "classic"
	}
	wp, err := s.store.Setting(r.Context(), defaultWallpaperKey)
	if err != nil {
		internalError(w, err)
		return
	}
	if wp != "" && !s.wallpaperExists(wp) {
		wp = ""
	}
	writeJSON(w, http.StatusOK, appearance{DefaultSkin: skin, DefaultWallpaper: wp})
}

// handleSetAppearance 设置平台默认的皮肤和壁纸，要有“应用管理”权限，和安装主题一样。
// 只改请求里带了的那一项。
func (s *Server) handleSetAppearance(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		DefaultSkin      *string `json:"defaultSkin"`
		DefaultWallpaper *string `json:"defaultWallpaper"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.DefaultSkin != nil && !validSkin(*req.DefaultSkin, s.themes()) {
		writeError(w, http.StatusBadRequest, "没有这个皮肤")
		return
	}
	if req.DefaultWallpaper != nil && *req.DefaultWallpaper != "" && !s.wallpaperExists(*req.DefaultWallpaper) {
		writeError(w, http.StatusBadRequest, "没有这张壁纸")
		return
	}
	for key, v := range map[string]*string{defaultSkinKey: req.DefaultSkin, defaultWallpaperKey: req.DefaultWallpaper} {
		if v == nil {
			continue
		}
		if err := s.store.SetSetting(r.Context(), key, *v); err != nil {
			internalError(w, err)
			return
		}
	}
	s.handleAppearance(w, r, u)
}
