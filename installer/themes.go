package main

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/Beane-Big/vibebooth/packages/manifest"
	"github.com/Beane-Big/vibebooth/packages/modpkg"
)

// 主题包上限：主题只有前端文件，解压后加起来不超过 20 MB。
const (
	maxThemeSize     = 20 << 20
	maxThemePackage  = 25 << 20
	themesDirName    = ".themes"
	themeStagePrefix = ".staging-"
)

// 主题放在模块卷的 .themes/<id>/ 下。目录以 . 开头，平台核心扫描模块时会跳过它；平台核心另外按目录读主题。
func (in *Installer) themesDir() string { return filepath.Join(in.dir, themesDirName) }

// ScriptError 表示主题带脚本，但管理员还没有确认。脚本在门户里以使用者的身份运行，能做他能做的任何事。
type ScriptError struct{}

func (e *ScriptError) Error() string {
	return "这个主题带脚本，会在门户里以使用者的身份运行，能看到和操作他能看到的一切。请确认它来自可信的来源后再安装"
}

// InstallTheme 安装或升级一个主题包：校验清单和文件清单，解压到暂存目录，再换成正式目录。
// 主题带脚本时，allowScript 必须为 true。主题没有容器，换好目录的那一刻门户就能选用它。
func (in *Installer) InstallTheme(zipPath string, allowScript bool, log io.Writer) (*manifest.Theme, error) {
	unlock, err := in.lock()
	if err != nil {
		return nil, err
	}
	defer unlock()

	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, modpkg.Invalid("不是有效的 zip 文件: %v", err)
	}
	defer zr.Close()
	files := map[string]*zip.File{}
	var total uint64
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		total += f.UncompressedSize64
		if total > maxThemeSize {
			return nil, modpkg.Invalid("主题包解压后超过 %d MB", maxThemeSize>>20)
		}
		files[f.Name] = f
	}
	mf, ok := files[manifest.ThemeFile]
	if !ok {
		return nil, modpkg.Invalid("主题包根目录下缺少 %s", manifest.ThemeFile)
	}
	data, err := readAll(mf)
	if err != nil {
		return nil, err
	}
	t, err := manifest.ParseTheme(data)
	if err != nil {
		return nil, modpkg.Invalid("%v", err)
	}
	if t.Script != "" && !allowScript {
		return nil, &ScriptError{}
	}
	declared := append(t.Files(), manifest.ThemeFile)
	for _, f := range t.Files() {
		if files[f] == nil {
			return nil, modpkg.Invalid("theme.yaml 里写了 %s，但主题包里没有这个文件", f)
		}
	}
	for name := range files {
		if !slices.Contains(declared, name) && !manifest.ValidThemeAsset(name) {
			return nil, modpkg.Invalid("主题包里不能有 %s：根目录只能放 theme.yaml 和它声明的文件，其他文件放进 assets/，类型限字体、图片、样式和脚本", name)
		}
		// 不带脚本的主题安装时不用确认，也就不能夹带脚本文件。
		if t.Script == "" && strings.EqualFold(filepath.Ext(name), ".js") {
			return nil, modpkg.Invalid("主题包里有脚本 %s，但 theme.yaml 没有声明 script：带脚本的主题要声明 script，安装时由管理员确认", name)
		}
	}

	old, upgrading := in.themes()[t.ID]
	if upgrading {
		fmt.Fprintf(log, "升级主题 %s：%s → %s\n", t.ID, old.Version, t.Version)
	} else {
		fmt.Fprintf(log, "安装主题 %s %s\n", t.ID, t.Version)
	}
	staging := filepath.Join(in.themesDir(), themeStagePrefix+t.ID)
	os.RemoveAll(staging)
	defer os.RemoveAll(staging)
	for name, f := range files {
		if err := extract(f, filepath.Join(staging, filepath.FromSlash(name))); err != nil {
			return nil, err
		}
	}
	if err := replaceDir(staging, filepath.Join(in.themesDir(), t.ID)); err != nil {
		return nil, err
	}
	fmt.Fprintf(log, "主题 %s %s 已安装，在头像菜单的“皮肤”里选用\n", t.ID, t.Version)
	return t, nil
}

// UninstallTheme 删除一个主题。正在用它的人下次打开门户时退回经典皮肤。
func (in *Installer) UninstallTheme(id string, log io.Writer) error {
	unlock, err := in.lock()
	if err != nil {
		return err
	}
	defer unlock()
	if _, ok := in.themes()[id]; !ok {
		return modpkg.Invalid("没有安装主题 %s", id)
	}
	if err := os.RemoveAll(filepath.Join(in.themesDir(), id)); err != nil {
		return err
	}
	fmt.Fprintf(log, "主题 %s 已卸载\n", id)
	return nil
}

// themes 读出已安装的主题。目录名必须和清单 id 一致，坏掉的清单跳过。
func (in *Installer) themes() map[string]*manifest.Theme {
	found := map[string]*manifest.Theme{}
	paths, _ := filepath.Glob(filepath.Join(in.themesDir(), "*", manifest.ThemeFile))
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
			found[t.ID] = t
		}
	}
	return found
}

func readAll(f *zip.File) ([]byte, error) {
	r, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, maxThemeSize))
}

// extract 解压一个文件。文件名已经校验过只能是根目录下的文件或 assets/ 下的子路径。
func extract(f *zip.File, to string) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	r, err := f.Open()
	if err != nil {
		return modpkg.Invalid("读不了 %s: %v", f.Name, err)
	}
	defer r.Close()
	w, err := os.Create(to)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, io.LimitReader(r, maxThemeSize))
	if cerr := w.Close(); err == nil {
		err = cerr
	}
	return err
}
