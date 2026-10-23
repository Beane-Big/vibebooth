package modpkg

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/Beane-Big/vibebooth/packages/manifest"
	"gopkg.in/yaml.v3"
)

// Pack 把模块的开发目录（模块仓库的根目录）和 docker save 导出的镜像打成模块包。
// 开发用的 compose.yaml 按 DevCompose 转换，打出的包再按安装器的规则完整校验一遍。
func Pack(moduleDir, imagesPath, out string) error {
	manifestData, err := os.ReadFile(filepath.Join(moduleDir, ManifestFile))
	if err != nil {
		return err
	}
	m, err := manifest.Parse(manifestData)
	if err != nil {
		return err
	}
	devCompose, err := os.ReadFile(filepath.Join(moduleDir, ComposeFile))
	if err != nil {
		return err
	}
	composeData, _, err := DevCompose(m, devCompose)
	if err != nil {
		return err
	}
	files := []zipEntry{
		{name: ManifestFile, data: manifestData},
		{name: ComposeFile, data: composeData},
		{name: ImagesFile, path: imagesPath},
	}
	if m.Icon != "" {
		files = append(files, zipEntry{name: m.Icon, path: filepath.Join(moduleDir, m.Icon)})
	}

	tmp := out + ".tmp"
	if err := writeZip(tmp, files); err != nil {
		os.Remove(tmp)
		return err
	}
	// 用安装器打开包时的同一套校验检查一遍，不合规范的包在本地就报错。
	pkg, err := OpenPackage(tmp)
	if err != nil {
		os.Remove(tmp)
		return err
	}
	pkg.Close()
	return os.Rename(tmp, out)
}

// zipEntry 是模块包里的一个文件：内容要么在 data 里，要么从 path 读取（镜像文件很大，不读进内存）。
type zipEntry struct {
	name string
	data []byte
	path string
}

func writeZip(path string, files []zipEntry) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	for _, file := range files {
		w, err := zw.Create(file.name)
		if err != nil {
			return err
		}
		if file.path == "" {
			_, err = w.Write(file.data)
		} else {
			err = copyFile(w, file.path)
		}
		if err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return f.Close()
}

func copyFile(w io.Writer, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(w, f)
	return err
}

// BuildTarget 是开发用 compose.yaml 里一个要构建的服务：Context 是相对模块根目录的构建目录，
// Dockerfile 是相对 Context 的文件名。
type BuildTarget struct {
	Service    string
	Image      string
	Context    string
	Dockerfile string
}

// DevCompose 把模块仓库里开发用的 compose.yaml 转成模块包里的版本：去掉 build、把 ${VERSION} 换成清单里的版本号，
// 并返回每个服务的构建目录。每个服务都要有 build，而且只能指向模块仓库里的目录，构建器据此在服务器上构建。
func DevCompose(m *manifest.Manifest, data []byte) ([]byte, []BuildTarget, error) {
	var raw map[string]any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, nil, Invalid("compose.yaml 格式错误: %v", err)
	}
	services, _ := raw["services"].(map[string]any)
	var targets []BuildTarget
	for name, sv := range services {
		s, ok := sv.(map[string]any)
		if !ok {
			return nil, nil, Invalid("compose.yaml: 服务 %s 格式错误", name)
		}
		target, err := buildTarget(name, s["build"])
		if err != nil {
			return nil, nil, err
		}
		delete(s, "build")
		if img, ok := s["image"].(string); ok {
			s["image"] = strings.ReplaceAll(img, "${VERSION}", m.Version)
			target.Image = s["image"].(string)
		}
		targets = append(targets, target)
	}
	release, err := yaml.Marshal(raw)
	if err != nil {
		return nil, nil, err
	}
	// 用安装器的规则校验转换后的文件，image 是否是 vb-<服务>:<版本> 也在这里检查。
	if _, err := ParseCompose(m, release); err != nil {
		return nil, nil, err
	}
	slices.SortFunc(targets, func(a, b BuildTarget) int { return strings.Compare(a.Service, b.Service) })
	return release, targets, nil
}

// buildTarget 解析服务的 build：可以是目录，也可以是只含 context 和 dockerfile 的映射。
func buildTarget(service string, v any) (BuildTarget, error) {
	t := BuildTarget{Service: service, Dockerfile: "Dockerfile"}
	switch b := v.(type) {
	case nil:
		return t, Invalid("服务 %s 缺少 build，模块的每个服务都要从模块仓库里构建", service)
	case string:
		t.Context = b
	case map[string]any:
		for key, val := range b {
			s, ok := val.(string)
			switch {
			case !ok:
				return t, Invalid("服务 %s 的 build.%s 必须是字符串", service, key)
			case key == "context":
				t.Context = s
			case key == "dockerfile":
				t.Dockerfile = s
			default:
				return t, Invalid("服务 %s 的 build 只能有 context 和 dockerfile，不能有 %s", service, key)
			}
		}
	default:
		return t, Invalid("服务 %s 的 build 格式错误", service)
	}
	var err error
	if t.Context, err = localPath(t.Context); err != nil {
		return t, Invalid("服务 %s 的 build 目录 %v", service, err)
	}
	if t.Dockerfile, err = localPath(t.Dockerfile); err != nil || t.Dockerfile == "." {
		return t, Invalid("服务 %s 的 dockerfile 必须是构建目录里的文件", service)
	}
	return t, nil
}

// localPath 要求路径是模块仓库里的相对路径，不能是绝对路径、网址或跳出仓库，返回清理后的路径。
func localPath(p string) (string, error) {
	if p == "" || strings.Contains(p, "://") || strings.Contains(p, "$") || strings.HasPrefix(p, "/") || strings.Contains(p, `\`) {
		return "", fmt.Errorf("%q 必须是模块仓库里的相对路径", p)
	}
	clean := path.Clean(p)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("%q 不能跳出模块仓库", p)
	}
	return clean, nil
}
