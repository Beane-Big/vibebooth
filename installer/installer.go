package main

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Beane-Big/vibebooth/packages/manifest"
	"gopkg.in/yaml.v3"
)

// Installer 管理模块卷里的已安装模块。每个模块一个目录：module.yaml、生成的 compose.yaml、图标。
// 平台核心定期扫描这个卷，所以目录写好的那一刻模块就出现在门户里，删掉目录就从门户消失。
type Installer struct {
	dir    string
	docker Docker
	// healthTimeout 是启动后等待健康检查通过的时间。
	healthTimeout time.Duration
}

// Installed 是一个已安装模块的概况，给命令行和应用管理页用。
type Installed struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Version     string   `json:"version"`
	Requires    []string `json:"requires"`
	RequiredBy  []string `json:"requiredBy"`
	Healthy     bool     `json:"healthy"`
}

func (in *Installer) moduleDir(id string) string { return filepath.Join(in.dir, id) }

// lock 保证同一时间只有一个安装或卸载在进行，命令行和网页同时操作也不会冲突。
func (in *Installer) lock() (func(), error) {
	f, err := os.OpenFile(filepath.Join(in.dir, ".lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() { f.Close() }, nil
}

func (in *Installer) installed() (map[string]*manifest.Manifest, error) {
	paths, err := filepath.Glob(filepath.Join(in.dir, "*", manifestFile))
	if err != nil {
		return nil, err
	}
	found := map[string]*manifest.Manifest{}
	for _, p := range paths {
		if strings.HasPrefix(filepath.Base(filepath.Dir(p)), ".") {
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		// 坏掉的清单（例如平台升级后格式变了）只跳过，不影响安装其他模块；重新安装这个模块即可修好。
		m, err := manifest.Parse(data)
		if err != nil {
			slog.Warn("跳过无法解析的已安装模块", "path", p, "err", err)
			continue
		}
		found[m.ID] = m
	}
	return found, nil
}

// Install 安装或升级一个模块包。失败时删除新容器；升级失败时恢复旧版本。
func (in *Installer) Install(ctx context.Context, zipPath string, log io.Writer) (*manifest.Manifest, error) {
	unlock, err := in.lock()
	if err != nil {
		return nil, err
	}
	defer unlock()

	pkg, err := OpenPackage(zipPath)
	if err != nil {
		return nil, err
	}
	defer pkg.Close()
	m := pkg.Manifest

	installed, err := in.installed()
	if err != nil {
		return nil, err
	}
	for _, d := range m.Deps {
		dep, ok := installed[d.ID]
		if !ok {
			return nil, invalid("%s 依赖模块 %s，请先安装它", m.ID, d)
		}
		if !d.SatisfiedBy(dep.Version) {
			return nil, invalid("%s 依赖 %s，当前装的是 %s，请先升级它", m.ID, d, dep.Version)
		}
	}
	// 反过来也要检查：装一个旧版本时，不能让已经依赖它新版本的模块失去依赖。
	for other, om := range installed {
		for _, d := range om.Deps {
			if d.ID == m.ID && !d.SatisfiedBy(m.Version) {
				return nil, invalid("%s 依赖 %s，不能装成 %s", other, d, m.Version)
			}
		}
	}
	old, upgrading := installed[m.ID]
	if upgrading {
		fmt.Fprintf(log, "升级 %s：%s → %s\n", m.ID, old.Version, m.Version)
	} else {
		fmt.Fprintf(log, "安装 %s %s\n", m.ID, m.Version)
	}

	c, err := parseCompose(m, pkg.Compose)
	if err != nil {
		return nil, err
	}
	rendered, err := c.Render()
	if err != nil {
		return nil, err
	}
	// 先写到 . 开头的暂存目录，平台核心不会读它；启动成功后再换成正式目录。
	staging := filepath.Join(in.dir, ".staging-"+m.ID)
	os.RemoveAll(staging)
	if err := writeModuleDir(staging, pkg, rendered); err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)

	images, err := pkg.Images()
	if err != nil {
		return nil, err
	}
	err = in.docker.Load(ctx, log, images)
	images.Close()
	if err != nil {
		return nil, err
	}

	project, stagedCompose := projectName(m.ID), filepath.Join(staging, composeFile)
	err = in.docker.Up(ctx, log, project, stagedCompose)
	if err == nil {
		err = in.waitHealthy(ctx, m)
	}
	if err != nil {
		fmt.Fprintf(log, "启动失败：%v\n", err)
		in.docker.Logs(ctx, log, project, stagedCompose)
		if upgrading {
			fmt.Fprintln(log, "恢复旧版本 "+old.Version)
			if rerr := in.docker.Up(ctx, log, project, filepath.Join(in.moduleDir(m.ID), composeFile)); rerr != nil {
				fmt.Fprintf(log, "恢复旧版本失败：%v\n", rerr)
			}
			// 版本号相同时新旧镜像是同一个名字，不能删。
			if old.Version != m.Version {
				in.docker.RemoveImages(ctx, log, c.images())
			}
		} else {
			in.docker.Down(ctx, log, project, stagedCompose, false)
		}
		return nil, err
	}

	if err := replaceDir(staging, in.moduleDir(m.ID)); err != nil {
		return nil, err
	}
	in.docker.RemoveOldImages(ctx, log, c.images())
	fmt.Fprintf(log, "%s %s 已就绪，几秒后出现在门户里\n", m.ID, m.Version)
	return m, nil
}

func writeModuleDir(dir string, pkg *Package, rendered []byte) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	files := map[string][]byte{manifestFile: pkg.ManifestData, composeFile: rendered}
	if pkg.Manifest.Icon != "" {
		files[pkg.Manifest.Icon] = pkg.Icon
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// replaceDir 用新目录替换旧目录，两次 rename 之间平台核心最多有一次扫描看不到这个模块。
func replaceDir(from, to string) error {
	old := filepath.Join(filepath.Dir(to), ".old-"+filepath.Base(to))
	os.RemoveAll(old)
	if err := os.Rename(to, old); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(from, to); err != nil {
		return err
	}
	return os.RemoveAll(old)
}

// waitHealthy 等后端健康检查返回 2xx、前端端口能连上。
func (in *Installer) waitHealthy(ctx context.Context, m *manifest.Manifest) error {
	deadline := time.Now().Add(in.healthTimeout)
	for {
		err := checkHealth(ctx, m)
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%d 秒内没有通过健康检查：%w", int(in.healthTimeout.Seconds()), err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

var healthClient = &http.Client{Timeout: 2 * time.Second}

func checkHealth(ctx context.Context, m *manifest.Manifest) error {
	if url := m.BackendURL(); url != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+m.HealthPath(), nil)
		if err != nil {
			return err
		}
		resp, err := healthClient.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			return fmt.Errorf("%s 返回 %s", m.HealthPath(), resp.Status)
		}
	}
	if s, ok := m.Services[manifest.Frontend]; ok {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(m.ContainerName(manifest.Frontend), strconv.Itoa(s.Port)), 2*time.Second)
		if err != nil {
			return err
		}
		conn.Close()
	}
	return nil
}

// Uninstall 先从模块卷里移走目录（门户里马上消失），再删除容器和镜像。数据卷默认保留。
func (in *Installer) Uninstall(ctx context.Context, id string, purge bool, log io.Writer) error {
	unlock, err := in.lock()
	if err != nil {
		return err
	}
	defer unlock()

	installed, err := in.installed()
	if err != nil {
		return err
	}
	if _, ok := installed[id]; !ok {
		return invalid("没有安装模块 %s", id)
	}
	if by := requiredBy(installed, id); len(by) > 0 {
		return invalid("%s 被 %s 依赖，请先卸载它们", id, strings.Join(by, "、"))
	}
	removing := filepath.Join(in.dir, ".removing-"+id)
	os.RemoveAll(removing)
	if err := os.Rename(in.moduleDir(id), removing); err != nil {
		return err
	}
	if err := in.docker.Down(ctx, log, projectName(id), filepath.Join(removing, composeFile), purge); err != nil {
		// 容器没删干净时把目录放回去，模块仍显示为已安装，可以再试一次。
		os.Rename(removing, in.moduleDir(id))
		return err
	}
	if purge {
		fmt.Fprintf(log, "%s 已卸载，数据已删除\n", id)
	} else {
		fmt.Fprintf(log, "%s 已卸载，数据卷保留，重新安装后数据还在\n", id)
	}
	return os.RemoveAll(removing)
}

func requiredBy(installed map[string]*manifest.Manifest, id string) []string {
	var by []string
	for other, m := range installed {
		if slices.Contains(m.RequiredIDs(), id) {
			by = append(by, other)
		}
	}
	sort.Strings(by)
	return by
}

// List 返回已安装的模块，按 id 排序，并检查各自是否健康。
func (in *Installer) List(ctx context.Context) ([]Installed, error) {
	installed, err := in.installed()
	if err != nil {
		return nil, err
	}
	list := []Installed{}
	for id, m := range installed {
		list = append(list, Installed{
			ID: id, Name: m.Name, Description: m.Description, Version: m.Version,
			Requires: orEmpty(m.RequiredIDs()), RequiredBy: orEmpty(requiredBy(installed, id)),
			Healthy: checkHealth(ctx, m) == nil,
		})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	return list, nil
}

// orEmpty 让 JSON 里输出 [] 而不是 null，前端不用判空。
func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// Pack 把模块的开发目录（模块仓库的根目录）和 docker save 导出的镜像打成模块包。
// 开发用的 compose.yaml 里有 build 和 ${VERSION}，打包时去掉 build、把版本号写死，再按安装器的规则完整校验一遍。
func Pack(moduleDir, imagesPath, out string) error {
	manifestData, err := os.ReadFile(filepath.Join(moduleDir, manifestFile))
	if err != nil {
		return err
	}
	m, err := manifest.Parse(manifestData)
	if err != nil {
		return err
	}
	devCompose, err := os.ReadFile(filepath.Join(moduleDir, composeFile))
	if err != nil {
		return err
	}
	var raw map[string]any
	if err := yaml.Unmarshal(devCompose, &raw); err != nil {
		return fmt.Errorf("compose.yaml 格式错误: %w", err)
	}
	services, _ := raw["services"].(map[string]any)
	for _, s := range services {
		if s, ok := s.(map[string]any); ok {
			delete(s, "build")
			if img, ok := s["image"].(string); ok {
				s["image"] = strings.ReplaceAll(img, "${VERSION}", m.Version)
			}
		}
	}
	composeData, err := yaml.Marshal(raw)
	if err != nil {
		return err
	}
	files := []zipEntry{
		{name: manifestFile, data: manifestData},
		{name: composeFile, data: composeData},
		{name: imagesFile, path: imagesPath},
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
