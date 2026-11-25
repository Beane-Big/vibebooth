package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

const (
	backupSettingsFile = "settings.json"
	maxBackupUpload    = 4 << 30
)

var backupIDPattern = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}-[a-z0-9-]+$`)
var modVolumePattern = regexp.MustCompile(`^mod-[a-z0-9][a-z0-9_-]{1,80}$`)

type BackupSettings struct {
	Enabled           bool   `json:"enabled"`
	Frequency         string `json:"frequency"` // daily | weekly
	Hour              int    `json:"hour"`      // 0..23
	Weekday           int    `json:"weekday"`   // 0=周日..6=周六
	IncludeModules    bool   `json:"includeModules"`
	KeepCount         int    `json:"keepCount"` // 1..90
	WebDAVEnabled     bool   `json:"webdavEnabled"`
	WebDAVURL         string `json:"webdavUrl"`
	WebDAVUsername    string `json:"webdavUsername"`
	WebDAVPassword    string `json:"webdavPassword,omitempty"`
	WebDAVPasswordSet bool   `json:"webdavPasswordSet,omitempty"`
}

func defaultBackupSettings() BackupSettings {
	return BackupSettings{
		Enabled:        false,
		Frequency:      "daily",
		Hour:           3,
		Weekday:        0,
		IncludeModules: true,
		KeepCount:      7,
	}
}

type BackupRecord struct {
	ID             string    `json:"id"`
	FileName       string    `json:"fileName"`
	Trigger        string    `json:"trigger"` // manual | scheduled | pre-restore
	IncludeModules bool      `json:"includeModules"`
	Volumes        []string  `json:"volumes"`
	Size           int64     `json:"size"`
	CreatedAt      time.Time `json:"createdAt"`
	WebDAVSynced   bool      `json:"webdavSynced"`
	WebDAVError    string    `json:"webdavError,omitempty"`
}

type BackupStatus struct {
	Running   bool      `json:"running"`
	Operation string    `json:"operation"` // "" | backup | restore
	Phase     string    `json:"phase"`
	LastError string    `json:"lastError"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type backupManifest struct {
	Version        int       `json:"version"`
	CreatedAt      time.Time `json:"createdAt"`
	Trigger        string    `json:"trigger"`
	IncludeModules bool      `json:"includeModules"`
	Volumes        []string  `json:"volumes"`
}

type BackupManager struct {
	backupsDir  string
	modulesDir  string
	coreDataDir string
	databaseURL string
	coreURL     string
	tz          *time.Location

	mu       sync.Mutex
	status   BackupStatus
	lastAuto string
}

func newBackupManager(backupsDir, modulesDir, coreDataDir, databaseURL, coreURL, tzName string) *BackupManager {
	loc, err := time.LoadLocation(tzName)
	if err != nil {
		loc = time.FixedZone("CST", 8*3600)
	}
	return &BackupManager{
		backupsDir:  backupsDir,
		modulesDir:  modulesDir,
		coreDataDir: coreDataDir,
		databaseURL: strings.TrimSpace(databaseURL),
		coreURL:     strings.TrimRight(coreURL, "/"),
		tz:          loc,
	}
}

func (m *BackupManager) StartScheduler(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			m.maybeRunScheduled(ctx, now.In(m.tz))
		}
	}
}

func (m *BackupManager) maybeRunScheduled(ctx context.Context, now time.Time) {
	st, err := m.LoadSettings()
	if err != nil || !st.Enabled {
		return
	}
	if now.Hour() != st.Hour {
		return
	}
	if st.Frequency == "weekly" && int(now.Weekday()) != st.Weekday {
		return
	}
	dayKey := now.Format("2006-01-02")
	m.mu.Lock()
	if m.status.Running || m.lastAuto == dayKey {
		m.mu.Unlock()
		return
	}
	m.lastAuto = dayKey
	m.mu.Unlock()
	go func() {
		if _, err := m.RunBackup(context.WithoutCancel(ctx), "scheduled", st.IncludeModules); err != nil {
			slog.Error("定时备份失败", "err", err)
		}
	}()
}

func (m *BackupManager) Status() BackupStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *BackupManager) setPhase(phase string) {
	m.mu.Lock()
	m.status.Phase = phase
	m.status.UpdatedAt = time.Now()
	m.mu.Unlock()
}

func (m *BackupManager) beginJob(op, phase string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.status.Running {
		return errors.New("已有备份或恢复任务正在进行，请稍候")
	}
	m.status = BackupStatus{Running: true, Operation: op, Phase: phase, UpdatedAt: time.Now()}
	return nil
}

func (m *BackupManager) finishJob(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status.Running = false
	m.status.Operation = ""
	m.status.Phase = ""
	if err != nil {
		m.status.LastError = err.Error()
	} else {
		m.status.LastError = ""
	}
	m.status.UpdatedAt = time.Now()
}

func (m *BackupManager) LoadSettings() (BackupSettings, error) {
	st := defaultBackupSettings()
	data, err := os.ReadFile(filepath.Join(m.backupsDir, backupSettingsFile))
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(data, &st); err != nil {
		return defaultBackupSettings(), err
	}
	if st.Frequency != "daily" && st.Frequency != "weekly" {
		st.Frequency = "daily"
	}
	if st.KeepCount < 1 {
		st.KeepCount = 7
	}
	return st, nil
}

func (m *BackupManager) MaskedSettings() (BackupSettings, error) {
	st, err := m.LoadSettings()
	if err != nil {
		return st, err
	}
	st.WebDAVPasswordSet = st.WebDAVPassword != ""
	st.WebDAVPassword = ""
	return st, nil
}

func (m *BackupManager) SaveSettings(in BackupSettings) (BackupSettings, error) {
	cur, err := m.LoadSettings()
	if err != nil {
		return BackupSettings{}, err
	}
	if in.Frequency != "daily" && in.Frequency != "weekly" {
		return BackupSettings{}, errors.New("备份频率只能是每天或每周")
	}
	if in.Hour < 0 || in.Hour > 23 {
		return BackupSettings{}, errors.New("备份时间须在 0 到 23 点之间")
	}
	if in.Weekday < 0 || in.Weekday > 6 {
		return BackupSettings{}, errors.New("星期参数不合法")
	}
	if in.KeepCount < 1 || in.KeepCount > 90 {
		return BackupSettings{}, errors.New("保留份数须在 1 到 90 之间")
	}
	in.WebDAVURL = strings.TrimSpace(in.WebDAVURL)
	in.WebDAVUsername = strings.TrimSpace(in.WebDAVUsername)
	if in.WebDAVPassword == "" && in.WebDAVPasswordSet {
		in.WebDAVPassword = cur.WebDAVPassword
	}
	if in.WebDAVEnabled {
		if err := validateWebDAVURL(in.WebDAVURL); err != nil {
			return BackupSettings{}, err
		}
	} else if in.WebDAVURL != "" {
		if err := validateWebDAVURL(in.WebDAVURL); err != nil {
			return BackupSettings{}, err
		}
	}
	in.WebDAVPasswordSet = false

	if err := os.MkdirAll(m.backupsDir, 0o700); err != nil {
		return BackupSettings{}, err
	}
	data, err := json.MarshalIndent(in, "", "  ")
	if err != nil {
		return BackupSettings{}, err
	}
	p := filepath.Join(m.backupsDir, backupSettingsFile)
	if err := os.WriteFile(p+".tmp", data, 0o600); err != nil {
		return BackupSettings{}, err
	}
	if err := os.Rename(p+".tmp", p); err != nil {
		_ = os.Remove(p + ".tmp")
		return BackupSettings{}, err
	}
	return m.MaskedSettings()
}

func (m *BackupManager) ListBackups() ([]BackupRecord, error) {
	entries, err := os.ReadDir(m.backupsDir)
	if errors.Is(err, os.ErrNotExist) {
		return []BackupRecord{}, nil
	}
	if err != nil {
		return nil, err
	}
	list := []BackupRecord{}
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".json") || ent.Name() == backupSettingsFile {
			continue
		}
		data, err := os.ReadFile(filepath.Join(m.backupsDir, ent.Name()))
		if err != nil {
			continue
		}
		var rec BackupRecord
		if json.Unmarshal(data, &rec) == nil && rec.ID != "" {
			if st, err := os.Stat(m.archivePath(rec.ID)); err == nil {
				rec.Size = st.Size()
				list = append(list, rec)
			}
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.After(list[j].CreatedAt) })
	return list, nil
}

func (m *BackupManager) archivePath(id string) string {
	return filepath.Join(m.backupsDir, id+".tar.gz")
}

func (m *BackupManager) metaPath(id string) string {
	return filepath.Join(m.backupsDir, id+".json")
}

func (m *BackupManager) DeleteBackup(id string) error {
	if !backupIDPattern.MatchString(id) {
		return os.ErrNotExist
	}
	if _, err := os.Stat(m.archivePath(id)); err != nil {
		return err
	}
	_ = os.Remove(m.archivePath(id))
	_ = os.Remove(m.metaPath(id))
	return nil
}

func (m *BackupManager) RunBackup(ctx context.Context, trigger string, includeModules bool) (*BackupRecord, error) {
	if err := m.beginJob("backup", "正在准备备份…"); err != nil {
		return nil, err
	}
	rec, err := m.runBackupUnlocked(ctx, trigger, includeModules, true)
	m.finishJob(err)
	if trigger != "pre-restore" {
		m.notifyBackupResult(trigger, rec, err)
	}
	return rec, err
}

func (m *BackupManager) runBackupUnlocked(ctx context.Context, trigger string, includeModules bool, syncAndPrune bool) (*BackupRecord, error) {
	if err := os.MkdirAll(m.backupsDir, 0o700); err != nil {
		return nil, err
	}
	now := time.Now().In(m.tz)
	id := now.Format("20060102-150405") + "-" + trigger
	finalPath := m.archivePath(id)
	tmpPath := finalPath + ".tmp"

	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpPath)
		}
	}()

	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	var volumes []string

	// 1. 导出 PostgreSQL 数据库
	if m.databaseURL != "" {
		m.setPhase("正在导出平台数据库…")
		sqlData, err := dumpPostgres(ctx, m.databaseURL)
		if err != nil {
			_ = tw.Close()
			_ = gz.Close()
			_ = f.Close()
			return nil, err
		}
		if err := writeTarBytes(tw, "platform.sql", sqlData); err != nil {
			_ = tw.Close()
			_ = gz.Close()
			_ = f.Close()
			return nil, err
		}
	}

	// 2. 打包 core-data 与 modules-data
	m.setPhase("正在打包平台核心数据与主题…")
	for _, pair := range []struct {
		name string
		dir  string
	}{
		{"home-platform_core-data", m.coreDataDir},
		{"home-platform_modules-data", m.modulesDir},
	} {
		if pair.dir == "" {
			continue
		}
		if _, err := os.Stat(pair.dir); err != nil {
			continue
		}
		buf, err := archiveDirTarGz(pair.dir)
		if err != nil {
			_ = tw.Close()
			_ = gz.Close()
			_ = f.Close()
			return nil, fmt.Errorf("打包 %s 失败: %w", pair.name, err)
		}
		if err := writeTarBytes(tw, "volumes/"+pair.name+".tar.gz", buf); err != nil {
			_ = tw.Close()
			_ = gz.Close()
			_ = f.Close()
			return nil, err
		}
		volumes = append(volumes, pair.name)
	}

	// 3. 打包所有 mod-* 模块数据卷
	if includeModules {
		modVols, err := listModuleVolumes(ctx)
		if err != nil {
			slog.Warn("枚举模块数据卷失败", "err", err)
		} else if len(modVols) > 0 {
			helper := detectHelperImage(ctx)
			for i, vol := range modVols {
				m.setPhase(fmt.Sprintf("正在打包应用数据卷（%d/%d）：%s", i+1, len(modVols), vol))
				buf, err := dumpDockerVolumeTarGz(ctx, helper, vol)
				if err != nil {
					_ = tw.Close()
					_ = gz.Close()
					_ = f.Close()
					return nil, fmt.Errorf("打包应用卷 %s 失败: %w", vol, err)
				}
				if err := writeTarBytes(tw, "volumes/"+vol+".tar.gz", buf); err != nil {
					_ = tw.Close()
					_ = gz.Close()
					_ = f.Close()
					return nil, err
				}
				volumes = append(volumes, vol)
			}
		}
	}

	// 4. 写入 manifest.json
	mf, _ := json.MarshalIndent(backupManifest{
		Version:        1,
		CreatedAt:      now.UTC(),
		Trigger:        trigger,
		IncludeModules: includeModules,
		Volumes:        volumes,
	}, "", "  ")
	if err := writeTarBytes(tw, "manifest.json", mf); err != nil {
		_ = tw.Close()
		_ = gz.Close()
		_ = f.Close()
		return nil, err
	}
	if err := tw.Close(); err != nil {
		_ = gz.Close()
		_ = f.Close()
		return nil, err
	}
	if err := gz.Close(); err != nil {
		_ = f.Close()
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return nil, err
	}
	cleanupTmp = false

	info, err := os.Stat(finalPath)
	if err != nil {
		return nil, err
	}
	rec := &BackupRecord{
		ID:             id,
		FileName:       "vibebooth-backup-" + id + ".tar.gz",
		Trigger:        trigger,
		IncludeModules: includeModules,
		Volumes:        volumes,
		Size:           info.Size(),
		CreatedAt:      now.UTC(),
	}
	if err := m.saveRecord(rec); err != nil {
		return nil, err
	}

	if syncAndPrune {
		st, err := m.LoadSettings()
		if err == nil {
			if st.WebDAVEnabled && st.WebDAVURL != "" {
				m.setPhase("正在上传到 WebDAV…")
				if err := uploadWebDAV(ctx, st.WebDAVURL, st.WebDAVUsername, st.WebDAVPassword, rec.FileName, finalPath); err != nil {
					rec.WebDAVError = err.Error()
					slog.Warn("WebDAV 上传备份失败", "err", err)
				} else {
					rec.WebDAVSynced = true
				}
				_ = m.saveRecord(rec)
			}
			m.pruneBackups(st.KeepCount)
		}
	}
	return rec, nil
}

func (m *BackupManager) saveRecord(rec *BackupRecord) error {
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.metaPath(rec.ID), data, 0o600)
}

func (m *BackupManager) pruneBackups(keep int) {
	if keep < 1 {
		return
	}
	list, err := m.ListBackups()
	if err != nil || len(list) <= keep {
		return
	}
	for _, old := range list[keep:] {
		_ = m.DeleteBackup(old.ID)
	}
}

func (m *BackupManager) RestoreFromFile(ctx context.Context, archivePath string) error {
	if err := validateBackupArchive(archivePath); err != nil {
		return err
	}
	if err := m.beginJob("restore", "正在恢复前创建保底快照…"); err != nil {
		return err
	}
	err := m.runRestoreUnlocked(ctx, archivePath)
	m.finishJob(err)
	m.notifyRestoreResult(err)
	return err
}

func (m *BackupManager) runRestoreUnlocked(ctx context.Context, archivePath string) error {
	// 先做一份本地保底快照（不推送 WebDAV、不触发清理），防止误操作丢失数据。
	if _, err := m.runBackupUnlocked(ctx, "pre-restore", true, false); err != nil {
		slog.Warn("恢复前创建保底快照失败，继续尝试恢复", "err", err)
	}

	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("备份文件格式错误: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	helper := ""
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("读取备份文件失败: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		name := strings.TrimPrefix(path.Clean(hdr.Name), "./")
		switch {
		case name == "platform.sql":
			if m.databaseURL == "" {
				continue
			}
			m.setPhase("正在恢复平台数据库…")
			if err := restorePostgres(ctx, m.databaseURL, tr); err != nil {
				return err
			}
		case name == "volumes/home-platform_core-data.tar.gz":
			if m.coreDataDir == "" {
				continue
			}
			m.setPhase("正在恢复平台核心数据…")
			if err := restoreDirTarGz(m.coreDataDir, tr); err != nil {
				return fmt.Errorf("恢复平台核心数据失败: %w", err)
			}
		case name == "volumes/home-platform_modules-data.tar.gz":
			if m.modulesDir == "" {
				continue
			}
			m.setPhase("正在恢复应用清单与主题…")
			if err := restoreDirTarGz(m.modulesDir, tr); err != nil {
				return fmt.Errorf("恢复应用清单与主题失败: %w", err)
			}
		case strings.HasPrefix(name, "volumes/mod-") && strings.HasSuffix(name, ".tar.gz"):
			vol := strings.TrimSuffix(strings.TrimPrefix(name, "volumes/"), ".tar.gz")
			if !modVolumePattern.MatchString(vol) {
				continue
			}
			if helper == "" {
				helper = detectHelperImage(ctx)
			}
			m.setPhase("正在恢复应用数据卷：" + vol)
			if err := restoreDockerVolumeTarGz(ctx, helper, vol, tr); err != nil {
				return fmt.Errorf("恢复应用卷 %s 失败: %w", vol, err)
			}
		}
	}

	m.reloadCoreRegistry(ctx)
	return nil
}

func validateBackupArchive(archivePath string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return errors.New("无法读取备份文件")
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return errors.New("不是有效的 .tar.gz 备份文件")
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var hasContent bool
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("备份文件已损坏")
		}
		name := strings.TrimPrefix(path.Clean(hdr.Name), "./")
		if strings.HasPrefix(name, "/") || strings.HasPrefix(name, "..") || strings.Contains(hdr.Name, `\`) {
			return errors.New("备份文件包含非法路径")
		}
		if name == "platform.sql" || strings.HasPrefix(name, "volumes/") {
			hasContent = true
		}
	}
	if !hasContent {
		return errors.New("备份文件中未找到平台数据")
	}
	return nil
}

// ---- 数据库与卷工具函数 ----

func dumpPostgres(ctx context.Context, databaseURL string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "pg_dump", databaseURL, "--clean", "--if-exists", "--no-owner")
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("导出数据库失败: %s", strings.TrimSpace(stderr.String()))
	}
	return out.Bytes(), nil
}

func restorePostgres(ctx context.Context, databaseURL string, r io.Reader) error {
	cmd := exec.CommandContext(ctx, "psql", databaseURL, "-v", "ON_ERROR_STOP=1")
	cmd.Stdin = r
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("恢复数据库失败: %s", strings.TrimSpace(stderr.String()))
	}
	return nil
}

func listModuleVolumes(ctx context.Context) ([]string, error) {
	out, err := exec.CommandContext(ctx, "docker", "volume", "ls", "--format", "{{.Name}}").Output()
	if err != nil {
		return nil, err
	}
	var vols []string
	for _, line := range strings.Fields(string(out)) {
		if modVolumePattern.MatchString(line) {
			vols = append(vols, line)
		}
	}
	sort.Strings(vols)
	return vols, nil
}

func detectHelperImage(ctx context.Context) string {
	for _, img := range []string{"alpine:3.22", "postgres:17-alpine", "alpine:latest"} {
		if exec.CommandContext(ctx, "docker", "image", "inspect", img).Run() == nil {
			return img
		}
	}
	return "alpine:3.22"
}

func dumpDockerVolumeTarGz(ctx context.Context, helperImage, volume string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm", "-v", volume+":/src:ro", helperImage, "tar", "czf", "-", "-C", "/src", ".")
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return out.Bytes(), nil
}

func restoreDockerVolumeTarGz(ctx context.Context, helperImage, volume string, r io.Reader) error {
	_ = exec.CommandContext(ctx, "docker", "volume", "create", volume).Run()
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm", "-i", "-v", volume+":/dst", helperImage,
		"sh", "-c", `rm -rf /dst/* /dst/.[!.]* /dst/..?* 2>/dev/null || true; tar xzf - -C /dst`)
	cmd.Stdin = r
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func archiveDirTarGz(dir string) ([]byte, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil || rel == "." {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		if d.IsDir() {
			hdr.Name += "/"
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if !d.IsDir() {
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(tw, f)
			f.Close()
			if copyErr != nil {
				return copyErr
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func restoreDirTarGz(dir string, r io.Reader) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()

	// 先清空目标目录内已有内容，再解压恢复。
	if ents, err := os.ReadDir(dir); err == nil {
		for _, ent := range ents {
			_ = os.RemoveAll(filepath.Join(dir, ent.Name()))
		}
	}

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		clean := path.Clean(strings.TrimPrefix(hdr.Name, "./"))
		if clean == "." || strings.HasPrefix(clean, "/") || strings.HasPrefix(clean, "..") || strings.Contains(hdr.Name, `\`) {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(clean))
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			perm := os.FileMode(hdr.Mode & 0o777)
			if perm == 0 {
				perm = 0o644
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, perm)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(out, tr)
			closeErr := out.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		}
	}
	return nil
}

func writeTarBytes(tw *tar.Writer, name string, data []byte) error {
	hdr := &tar.Header{
		Name:    name,
		Mode:    0o644,
		Size:    int64(len(data)),
		ModTime: time.Now(),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}

// ---- WebDAV 同步 ----

var backupHTTPClient = &http.Client{Timeout: 10 * time.Minute}
var quickHTTPClient = &http.Client{Timeout: 10 * time.Second}

func validateWebDAVURL(raw string) error {
	v := strings.TrimSpace(raw)
	if v == "" || len(v) > 512 {
		return errors.New("请输入有效的 WebDAV 地址")
	}
	u, err := neturl.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return errors.New("WebDAV 地址必须以 http:// 或 https:// 开头")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && ip.IsLinkLocalUnicast() {
		return errors.New("不允许使用该地址")
	}
	return nil
}

func testWebDAV(ctx context.Context, rawURL, username, password string) error {
	if err := validateWebDAVURL(rawURL); err != nil {
		return err
	}
	target := strings.TrimRight(strings.TrimSpace(rawURL), "/") + "/"
	req, err := http.NewRequestWithContext(ctx, "PROPFIND", target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Depth", "0")
	if username != "" || password != "" {
		req.SetBasicAuth(username, password)
	}
	resp, err := quickHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return errors.New("账号或密码认证失败")
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 || resp.StatusCode == http.StatusMultiStatus {
		return nil
	}
	// 部分 WebDAV 服务对根路径返回 405 Method Not Allowed，回退用 OPTIONS 检查。
	if resp.StatusCode == http.StatusMethodNotAllowed {
		req2, err := http.NewRequestWithContext(ctx, http.MethodOptions, target, nil)
		if err != nil {
			return err
		}
		if username != "" || password != "" {
			req2.SetBasicAuth(username, password)
		}
		resp2, err := quickHTTPClient.Do(req2)
		if err != nil {
			return err
		}
		defer resp2.Body.Close()
		if resp2.StatusCode >= 200 && resp2.StatusCode < 300 {
			return nil
		}
		return fmt.Errorf("服务器返回 HTTP %d", resp2.StatusCode)
	}
	return fmt.Errorf("服务器返回 HTTP %d", resp.StatusCode)
}

func uploadWebDAV(ctx context.Context, rawURL, username, password, fileName, localPath string) error {
	if err := validateWebDAVURL(rawURL); err != nil {
		return err
	}
	f, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	target := strings.TrimRight(strings.TrimSpace(rawURL), "/") + "/" + neturl.PathEscape(fileName)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target, f)
	if err != nil {
		return err
	}
	req.ContentLength = info.Size()
	req.Header.Set("Content-Type", "application/gzip")
	if username != "" || password != "" {
		req.SetBasicAuth(username, password)
	}
	resp, err := backupHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("WebDAV 上传返回 HTTP %d", resp.StatusCode)
	}
	return nil
}

// ---- 与 core 交互（校验管理员密码、通知、重载注册表） ----

func (m *BackupManager) verifyAdminPassword(ctx context.Context, userID int64, password string) error {
	if m.coreURL == "" {
		return nil
	}
	body, _ := json.Marshal(map[string]any{"userId": userID, "password": password})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.coreURL+"/api/platform/ext/v1/auth/verify-admin-password", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := quickHTTPClient.Do(req)
	if err != nil {
		return errors.New("无法校验管理员密码，请稍后重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return errors.New("管理员密码不正确")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New("校验管理员密码失败")
	}
	return nil
}

func (m *BackupManager) reloadCoreRegistry(ctx context.Context) {
	if m.coreURL == "" {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.coreURL+"/api/platform/ext/v1/registry/reload", nil)
	if err != nil {
		return
	}
	resp, err := quickHTTPClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

func (m *BackupManager) notifyBackupResult(trigger string, rec *BackupRecord, err error) {
	if m.coreURL == "" {
		return
	}
	kind := "手动备份"
	if trigger == "scheduled" {
		kind = "定时备份"
	}
	title := kind + "完成"
	body := ""
	if err != nil {
		title = kind + "失败"
		body = err.Error()
	} else if rec != nil {
		body = fmt.Sprintf("文件大小 %.1f MB", float64(rec.Size)/(1<<20))
		if rec.WebDAVSynced {
			body += "，已同步至 WebDAV"
		} else if rec.WebDAVError != "" {
			body += "（WebDAV 同步失败：" + rec.WebDAVError + "）"
		}
	}
	m.sendAdminNotification(title, body, "backup-"+trigger)
}

func (m *BackupManager) notifyRestoreResult(err error) {
	if m.coreURL == "" {
		return
	}
	title := "数据恢复完成"
	body := "平台与应用数据已按所选备份恢复。"
	if err != nil {
		title = "数据恢复失败"
		body = err.Error()
	}
	m.sendAdminNotification(title, body, "backup-restore")
}

func (m *BackupManager) sendAdminNotification(title, body, dedup string) {
	payload, _ := json.Marshal(map[string]any{
		"target":   map[string]any{"role": "admin"},
		"appId":    "platform",
		"title":    title,
		"body":     body,
		"link":     "/settings/backup",
		"dedupKey": dedup,
		"urgent":   true,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.coreURL+"/api/platform/ext/v1/notifications", bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := quickHTTPClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

// ---- HTTP Handlers（仅限管理员角色） ----

func requireAdminRole(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := auth.UserFrom(r.Context())
		if user == nil || !slices.Contains(user.Roles, "admin") {
			writeError(w, http.StatusForbidden, "只有管理员可以操作数据备份", "")
			return
		}
		next(w, r)
	}
}

func (s *server) listBackups(w http.ResponseWriter, _ *http.Request) {
	items, err := s.backups.ListBackups()
	if err != nil {
		slog.Error("读取备份列表失败", "err", err)
		writeError(w, http.StatusInternalServerError, "读取备份列表失败", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": s.backups.Status(),
		"items":  items,
	})
}

func (s *server) createBackup(w http.ResponseWriter, r *http.Request) {
	st, err := s.backups.LoadSettings()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取备份设置失败", "")
		return
	}
	includeModules := st.IncludeModules
	if r.ContentLength > 0 {
		var in struct {
			IncludeModules *bool `json:"includeModules"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&in); err == nil && in.IncludeModules != nil {
			includeModules = *in.IncludeModules
		}
	}
	if s.backups.Status().Running {
		writeError(w, http.StatusConflict, "已有备份或恢复任务正在进行", "")
		return
	}
	go func() {
		if _, err := s.backups.RunBackup(context.Background(), "manual", includeModules); err != nil {
			slog.Error("手动备份失败", "err", err)
		}
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"started": true})
}

func (s *server) getBackupSettings(w http.ResponseWriter, _ *http.Request) {
	st, err := s.backups.MaskedSettings()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取备份设置失败", "")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *server) saveBackupSettings(w http.ResponseWriter, r *http.Request) {
	var in BackupSettings
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "格式错误", "")
		return
	}
	saved, err := s.backups.SaveSettings(in)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

func (s *server) testBackupWebDAV(w http.ResponseWriter, r *http.Request) {
	var in struct {
		URL         string `json:"webdavUrl"`
		Username    string `json:"webdavUsername"`
		Password    string `json:"webdavPassword"`
		UseSavedPwd bool   `json:"useSavedPassword"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "格式错误", "")
		return
	}
	pwd := in.Password
	if pwd == "" && in.UseSavedPwd {
		if cur, err := s.backups.LoadSettings(); err == nil {
			pwd = cur.WebDAVPassword
		}
	}
	if err := testWebDAV(r.Context(), in.URL, in.Username, pwd); err != nil {
		writeError(w, http.StatusBadGateway, "连接失败："+err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) downloadBackup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !backupIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "备份不存在", "")
		return
	}
	p := s.backups.archivePath(id)
	f, err := os.Open(p)
	if err != nil {
		writeError(w, http.StatusNotFound, "备份不存在", "")
		return
	}
	defer f.Close()
	name := "vibebooth-backup-" + id + ".tar.gz"
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+neturl.PathEscape(name))
	http.ServeContent(w, r, name, time.Time{}, f)
}

func (s *server) deleteBackup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.backups.DeleteBackup(id); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "备份不存在", "")
			return
		}
		writeError(w, http.StatusInternalServerError, "删除备份失败", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) restoreBackup(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFrom(r.Context())
	uid, err := strconv.ParseInt(user.ID, 10, 64)
	if err != nil || uid <= 0 {
		writeError(w, http.StatusForbidden, "无效的管理员会话", "")
		return
	}
	if s.backups.Status().Running {
		writeError(w, http.StatusConflict, "已有备份或恢复任务正在进行", "")
		return
	}

	var password, backupID, uploadedTmp string
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		r.Body = http.MaxBytesReader(w, r.Body, maxBackupUpload+1<<20)
		mr, err := r.MultipartReader()
		if err != nil {
			writeError(w, http.StatusBadRequest, "请上传备份文件", "")
			return
		}
		for {
			part, err := mr.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				if uploadedTmp != "" {
					_ = os.Remove(uploadedTmp)
				}
				writeError(w, http.StatusBadRequest, "读取上传内容失败", "")
				return
			}
			switch part.FormName() {
			case "password":
				b, _ := io.ReadAll(io.LimitReader(part, 1024))
				password = string(b)
			case "file":
				f, err := os.CreateTemp(s.backups.backupsDir, ".restore-*.tar.gz")
				if err != nil {
					_ = os.MkdirAll(s.backups.backupsDir, 0o700)
					f, err = os.CreateTemp(s.backups.backupsDir, ".restore-*.tar.gz")
				}
				if err != nil {
					writeError(w, http.StatusInternalServerError, "保存备份文件失败", "")
					return
				}
				_, copyErr := io.Copy(f, part)
				closeErr := f.Close()
				if copyErr != nil || closeErr != nil {
					_ = os.Remove(f.Name())
					writeError(w, http.StatusBadRequest, "上传备份文件失败", "")
					return
				}
				uploadedTmp = f.Name()
			}
		}
	} else {
		var in struct {
			ID       string `json:"id"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "格式错误", "")
			return
		}
		backupID = strings.TrimSpace(in.ID)
		password = in.Password
	}

	cleanup := func() {
		if uploadedTmp != "" {
			_ = os.Remove(uploadedTmp)
		}
	}

	if password == "" {
		cleanup()
		writeError(w, http.StatusBadRequest, "请输入管理员当前密码以确认恢复", "")
		return
	}
	if err := s.backups.verifyAdminPassword(r.Context(), uid, password); err != nil {
		cleanup()
		writeError(w, http.StatusUnauthorized, err.Error(), "")
		return
	}

	var targetPath string
	if uploadedTmp != "" {
		targetPath = uploadedTmp
	} else {
		if !backupIDPattern.MatchString(backupID) {
			writeError(w, http.StatusNotFound, "备份不存在", "")
			return
		}
		targetPath = s.backups.archivePath(backupID)
		if _, err := os.Stat(targetPath); err != nil {
			writeError(w, http.StatusNotFound, "备份不存在", "")
			return
		}
	}

	if err := validateBackupArchive(targetPath); err != nil {
		cleanup()
		writeError(w, http.StatusBadRequest, err.Error(), "")
		return
	}

	go func() {
		defer cleanup()
		if err := s.backups.RestoreFromFile(context.Background(), targetPath); err != nil {
			slog.Error("恢复备份失败", "err", err)
		}
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"started": true})
}
