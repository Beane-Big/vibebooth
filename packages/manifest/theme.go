package manifest

import (
	"bytes"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// SupportedThemePlatform 是这个版本的平台支持的最高主题规范版本，对应 theme.yaml 里的 platform。
// 门户提供给主题的接口（window.vibebooth）有不兼容的改动时加 1；新增可选字段不加。
const SupportedThemePlatform = 1

// ThemeFile 是主题包里的清单文件名。
const ThemeFile = "theme.yaml"

// Theme 是主题清单 theme.yaml。主题只有前端文件，没有容器：门户加载它的脚本和样式，替换外观和首页。
type Theme struct {
	Platform    int    `yaml:"platform" json:"platform"`
	ID          string `yaml:"id" json:"id"`
	Name        string `yaml:"name" json:"name"`
	Description string `yaml:"description" json:"description"`
	Version     string `yaml:"version" json:"version"`
	// Script 是主题的脚本（IIFE 格式），加载后调用 window.vibebooth.registerTheme 注册自己。
	Script string `yaml:"script" json:"script,omitempty"`
	// Style 是主题的样式表，选用主题时加载。
	Style string `yaml:"style" json:"style,omitempty"`
	// Preview 是应用管理页和皮肤选择里显示的预览图。
	Preview string `yaml:"preview" json:"preview,omitempty"`
}

// ThemeAssetsDir 是主题包里放字体、图片等附带文件的目录，样式表里用相对路径引用。
const ThemeAssetsDir = "assets/"

var (
	scriptTypes  = map[string]bool{".js": true}
	styleTypes   = map[string]bool{".css": true}
	previewTypes = map[string]bool{".svg": true, ".png": true, ".jpg": true, ".webp": true}
	// ThemeAssetTypes 是 assets/ 里允许的文件类型。主题文件由平台核心直接发给浏览器，只放静态资源。
	ThemeAssetTypes = map[string]bool{
		".svg": true, ".png": true, ".jpg": true, ".webp": true, ".gif": true,
		".woff": true, ".woff2": true, ".css": true, ".js": true, ".json": true,
	}
	themeFilePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
)

// ParseTheme 解析并校验主题清单。未知字段视为错误，避免拼错的字段被悄悄忽略。
func ParseTheme(data []byte) (*Theme, error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var t Theme
	if err := dec.Decode(&t); err != nil {
		return nil, fmt.Errorf("theme.yaml 格式错误: %w", err)
	}
	if err := t.validate(); err != nil {
		return nil, err
	}
	return &t, nil
}

func (t *Theme) validate() error {
	if t.Platform == 0 {
		t.Platform = 1
	}
	if t.Platform < 0 {
		return errors.New("platform 必须是正整数")
	}
	if t.Platform > SupportedThemePlatform {
		return fmt.Errorf("这个主题需要主题规范 %d，当前平台只支持到 %d，请先升级平台", t.Platform, SupportedThemePlatform)
	}
	// 主题 id 和模块 id 是两套，规则一样；内置皮肤的名字不能用，免得选择时分不清。
	if !idPattern.MatchString(t.ID) || t.ID == "classic" || t.ID == "tiles" {
		return errors.New("id 只能是小写字母开头的小写字母、数字和连字符（2 到 31 个字符），且不能是 classic、tiles")
	}
	if strings.TrimSpace(t.Name) == "" {
		return errors.New("缺少 name")
	}
	if !versionPattern.MatchString(t.Version) {
		return errors.New("version 必须是 x.y.z 格式")
	}
	if t.Script == "" && t.Style == "" {
		return errors.New("script 和 style 至少要有一个")
	}
	for _, f := range []struct {
		field, value string
		types        map[string]bool
	}{{"script", t.Script, scriptTypes}, {"style", t.Style, styleTypes}, {"preview", t.Preview, previewTypes}} {
		if f.value != "" && (!themeFilePattern.MatchString(f.value) || !f.types[strings.ToLower(path.Ext(f.value))]) {
			return fmt.Errorf("%s 必须是主题包根目录下的文件名，类型是 %s", f.field, typeList(f.types))
		}
	}
	return nil
}

// Files 是清单里声明的文件，都在主题包根目录下。
func (t *Theme) Files() []string {
	var files []string
	for _, f := range []string{t.Script, t.Style, t.Preview} {
		if f != "" {
			files = append(files, f)
		}
	}
	return files
}

// ValidThemeAsset 判断 assets/ 下的一个文件路径是否合法：只能是 assets/ 下的子路径，类型在白名单里。
func ValidThemeAsset(name string) bool {
	if !strings.HasPrefix(name, ThemeAssetsDir) || path.Clean(name) != name {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if !themeFilePattern.MatchString(part) || strings.HasPrefix(part, ".") {
			return false
		}
	}
	return ThemeAssetTypes[strings.ToLower(path.Ext(name))]
}

func typeList(types map[string]bool) string {
	var list []string
	for _, ext := range []string{".js", ".css", ".svg", ".png", ".jpg", ".webp"} {
		if types[ext] {
			list = append(list, ext)
		}
	}
	return strings.Join(list, "、")
}
