// 构建器模块后端：接收模块源码包，通过平台的构建代理构建镜像，打出和 npm run pack 一样的软件包。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

const moduleID = "platform-builder"

func main() {
	dataDir := env("DATA_DIR", "/data")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		fatal("创建数据目录失败", err)
	}
	store, err := OpenStore(filepath.Join(dataDir, "builder.db"))
	if err != nil {
		fatal("打开数据库失败", err)
	}
	// 安装器给声明了 docker-build 特权的模块设置 DOCKER_HOST，指向平台的构建代理。
	docker, err := newDockerClient(env("DOCKER_HOST", "tcp://build-proxy:2375"))
	if err != nil {
		fatal("连接构建代理失败", err)
	}
	b := newBuilder(store, docker, dataDir)
	go b.run(context.Background())
	h := &handlers{store: store, builder: b, links: newInstallLinks()}
	verifier := auth.NewVerifier(env("JWKS_URL", "http://core:8080/api/platform/.well-known/jwks.json"), moduleID)

	// 对内接口：只给本模块前端用，需要登录。
	api := http.NewServeMux()
	api.HandleFunc("GET /api/platform/builder/me", h.me)
	api.HandleFunc("GET /api/platform/builder/builds", h.list)
	api.HandleFunc("POST /api/platform/builder/builds", h.upload)
	api.HandleFunc("GET /api/platform/builder/builds/{id}", h.detail)
	api.HandleFunc("GET /api/platform/builder/builds/{id}/package", h.download)
	api.HandleFunc("DELETE /api/platform/builder/builds/{id}", h.remove)
	api.HandleFunc("GET /api/platform/builder/builds/{id}/install", h.installLog)
	api.HandleFunc("PUT /api/platform/builder/builds/{id}/install", requireAdmin(h.saveInstall))
	api.HandleFunc("POST /api/platform/builder/builds/{id}/install-link", requireAdmin(h.createInstallLink))
	// 保留规则所有人都能看，构建记录页据此显示每条记录什么时候删除。
	api.HandleFunc("GET /api/platform/builder/rules", h.rules)
	// 保留规则和镜像源属于设置，只有有“设置”菜单的人能改；门户只是对他们显示设置入口，权限以这里为准。
	api.HandleFunc("GET /api/platform/builder/settings", h.settings)
	api.HandleFunc("PUT /api/platform/builder/settings", h.saveSettings)
	api.HandleFunc("POST /api/platform/builder/cache/prune", h.pruneCache)
	api.HandleFunc("GET /api/platform/builder/skill", h.downloadSkill)
	api.HandleFunc("GET /api/platform/builder/theme-skill", h.downloadThemeSkill)

	mux := http.NewServeMux()
	// 健康检查由平台在内部网络直接调用，不经过网关，也不需要令牌。
	mux.HandleFunc("GET /api/platform/builder/health", func(w http.ResponseWriter, r *http.Request) {
		if err := docker.ping(r.Context()); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/api/platform/builder/", verifier.Middleware(adminOnly(api)))
	mux.Handle("GET /apps/builder/{$}", verifier.Middleware(adminOnly(http.RedirectHandler("/applications/build", http.StatusFound))))
	mux.Handle("GET /apps/builder/settings", verifier.Middleware(adminOnly(http.RedirectHandler("/applications/build/settings", http.StatusFound))))
	mux.Handle("GET /apps/builder/settings/{$}", verifier.Middleware(adminOnly(http.RedirectHandler("/applications/build/settings", http.StatusFound))))
	// 平台安装器在内部网络里下载软件包，见 installlink.go。
	mux.HandleFunc("GET /internal/packages/{token}", h.internalPackage)

	srv := &http.Server{Addr: ":8000", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	slog.Info("平台构建服务已启动", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil {
		fatal("服务退出", err)
	}
}

func adminOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isAdmin(r) {
			writeError(w, http.StatusForbidden, "只有管理员能使用构建功能")
			return
		}
		w.Header().Set("Cache-Control", "private, no-store")
		next.ServeHTTP(w, r)
	})
}

type handlers struct {
	store   *Store
	builder *builder
	links   *installLinks
}

func (h *handlers) me(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFrom(r.Context())
	// 一键安装调用的是平台安装器的接口，只有管理员能用；前端据此决定显不显示安装按钮。
	writeJSON(w, http.StatusOK, map[string]any{"name": user.Name, "menus": []string{"home", "settings"}, "admin": isAdmin(r)})
}

func (h *handlers) list(w http.ResponseWriter, r *http.Request) {
	builds, err := h.store.List(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, builds)
}

// upload 接收源码包（表单字段 source，可选 installAfter）。先按平台规则检查清单和 compose.yaml，通过了才排队构建。
func (h *handlers) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSourceSize+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "请上传源码包")
		return
	}
	var tmp string
	var installAfter bool
	defer func() {
		if tmp != "" {
			os.Remove(tmp)
		}
	}()
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("源码包不能超过 %d MB", maxSourceSize>>20))
			} else {
				writeError(w, http.StatusBadRequest, "请上传源码包")
			}
			return
		}
		switch part.FormName() {
		case "source":
			if tmp != "" {
				continue
			}
			tmp, err = saveUpload(h.builder.dir, part)
			if err != nil {
				var tooLarge *http.MaxBytesError
				if errors.As(err, &tooLarge) {
					writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("源码包不能超过 %d MB", maxSourceSize>>20))
				} else {
					internalError(w, err)
				}
				return
			}
		case "installAfter":
			data, _ := io.ReadAll(io.LimitReader(part, 16))
			v := strings.TrimSpace(string(data))
			installAfter = v == "true" || v == "1"
		}
	}
	if tmp == "" {
		writeError(w, http.StatusBadRequest, "请上传源码包")
		return
	}
	src, err := inspectSource(tmp)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rec := &Build{
		ModuleID:     src.manifest.ID,
		ModuleName:   src.manifest.Name,
		Version:      src.manifest.Version,
		CreatedBy:    auth.UserFrom(r.Context()).Name,
		InstallAfter: installAfter,
	}
	if err := h.store.Add(r.Context(), rec); err != nil {
		internalError(w, err)
		return
	}
	if err = os.MkdirAll(h.builder.buildDir(rec.ID), 0o755); err == nil {
		err = os.Rename(tmp, h.builder.sourcePath(rec.ID))
	}
	if err != nil {
		h.store.Delete(r.Context(), rec.ID)
		internalError(w, err)
		return
	}
	tmp = ""
	h.builder.enqueue(rec.ID)
	writeJSON(w, http.StatusCreated, rec)
}

func saveUpload(dir string, r io.Reader) (string, error) {
	f, err := os.CreateTemp(dir, ".upload-*.zip")
	if err != nil {
		return "", err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// maxLogSize 是详情接口最多返回的日志长度，太长时只返回最后这一段。
const maxLogSize = 512 << 10

func (h *handlers) detail(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.find(w, r)
	if !ok {
		return
	}
	log, truncated := tail(h.builder.logPath(rec.ID), maxLogSize)
	var diagnosis *BuildDiagnosis
	if rec.Status == statusFailed {
		if st, err := h.store.Settings(r.Context()); err == nil {
			diagnosis = diagnoseBuild(log, st)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"build":        rec,
		"log":          log,
		"logTruncated": truncated,
		"diagnosis":    diagnosis,
	})
}

func (h *handlers) pruneCache(w http.ResponseWriter, r *http.Request) {
	reclaimed, err := h.builder.docker.pruneCache(r.Context(), 0)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"reclaimedBytes": reclaimed})
}

func tail(path string, limit int64) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", false
	}
	truncated := info.Size() > limit
	if truncated {
		f.Seek(info.Size()-limit, io.SeekStart)
	}
	data, _ := io.ReadAll(io.LimitReader(f, limit))
	return strings.ToValidUTF8(string(data), ""), truncated
}

func (h *handlers) download(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.find(w, r)
	if !ok {
		return
	}
	if rec.Status != statusSuccess {
		writeError(w, http.StatusNotFound, "这次构建没有软件包")
		return
	}
	f, err := os.Open(h.builder.packagePath(rec.ID))
	if err != nil {
		writeError(w, http.StatusNotFound, "软件包已被清理")
		return
	}
	defer f.Close()
	name := fmt.Sprintf("%s-%s.zip", rec.ModuleID, rec.Version)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	http.ServeContent(w, r, name, time.Time{}, f)
}

func (h *handlers) remove(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.find(w, r)
	if !ok {
		return
	}
	if err := h.builder.remove(r.Context(), rec.ID); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// maxInstallLogSize 是安装日志最多保存的长度，安装器的日志一般只有几 KB。
const maxInstallLogSize = 1 << 20

// saveInstall 记下在构建器里安装的结果和日志。安装请求由前端发给平台安装器（软件包由安装器在内部网络里下载，见 installlink.go），装完由前端报回来。
func (h *handlers) saveInstall(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.find(w, r)
	if !ok {
		return
	}
	if rec.Status != statusSuccess {
		writeError(w, http.StatusBadRequest, "这次构建没有软件包")
		return
	}
	var body struct {
		OK  bool   `json:"ok"`
		Log string `json:"log"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxInstallLogSize+64<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "格式错误")
		return
	}
	if err := os.WriteFile(h.builder.installLogPath(rec.ID), []byte(body.Log), 0o644); err != nil {
		internalError(w, err)
		return
	}
	status := installFailed
	if body.OK {
		status = installSuccess
	}
	if err := h.store.SetInstall(r.Context(), rec.ID, status, auth.UserFrom(r.Context()).Name); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) installLog(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.find(w, r)
	if !ok {
		return
	}
	log, _ := tail(h.builder.installLogPath(rec.ID), maxInstallLogSize)
	writeJSON(w, http.StatusOK, map[string]string{"log": log})
}

func (h *handlers) rules(w http.ResponseWriter, r *http.Request) {
	st, err := h.store.Settings(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"maxPackages": st.MaxPackages, "maxDays": st.MaxDays})
}

func (h *handlers) find(w http.ResponseWriter, r *http.Request) (*Build, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, ErrNotFound.Error())
		return nil, false
	}
	rec, err := h.store.Get(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		writeError(w, http.StatusNotFound, err.Error())
		return nil, false
	}
	if err != nil {
		internalError(w, err)
		return nil, false
	}
	return rec, true
}

func (h *handlers) settings(w http.ResponseWriter, r *http.Request) {
	st, err := h.store.Settings(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (h *handlers) saveSettings(w http.ResponseWriter, r *http.Request) {
	var st Settings
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&st); err != nil {
		writeError(w, http.StatusBadRequest, "格式错误")
		return
	}
	st.BuildArgs = cleanBuildArgs(st.BuildArgs)
	if msg := validateSettings(st); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if err := h.store.SaveSettings(r.Context(), st); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// cleanBuildArgs 去掉首尾空格；名字和值都空着的行是点了“添加参数”没填，直接去掉，不当成错误。
func cleanBuildArgs(in []BuildArg) []BuildArg {
	out := []BuildArg{}
	for _, a := range in {
		a.Name, a.Value = strings.TrimSpace(a.Name), strings.TrimSpace(a.Value)
		if a.Name != "" || a.Value != "" {
			out = append(out, a)
		}
	}
	return out
}

func validateSettings(st Settings) string {
	switch {
	case st.MaxPackages < 1 || st.MaxPackages > 50:
		return "每个模块保留的软件包数要在 1 到 50 之间"
	case st.MaxDays < 1 || st.MaxDays > 365:
		return "保留天数要在 1 到 365 之间"
	case st.CacheGB < 1 || st.CacheGB > 100:
		return "构建缓存上限要在 1 到 100 GB 之间"
	case len(st.BuildArgs) > maxBuildArgs:
		return fmt.Sprintf("构建参数最多 %d 个", maxBuildArgs)
	}
	seen := map[string]bool{}
	for _, a := range st.BuildArgs {
		switch {
		case !argName.MatchString(a.Name):
			return "构建参数名 " + strconv.Quote(a.Name) + " 不对：只能用英文字母、数字和下划线，不能以数字开头"
		case seen[a.Name]:
			return "构建参数 " + a.Name + " 重复了"
		case a.Value == "" || strings.ContainsAny(a.Value, " \t\r\n"):
			return "构建参数 " + a.Name + " 的值不能为空，也不能有空格"
		case len(a.Value) > 2000:
			return "构建参数 " + a.Name + " 的值太长"
		}
		seen[a.Name] = true
	}
	return ""
}

const maxBuildArgs = 30

// 构建参数名和 Dockerfile 里 ARG 的写法一样。
var argName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ---- 工具函数 ----

// requireAdmin 要求当前用户是管理员。在构建器里安装用的是平台安装器的接口，只有管理员能装，安装结果也只收管理员的。
func requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isAdmin(r) {
			writeError(w, http.StatusForbidden, "只有管理员能安装")
			return
		}
		next(w, r)
	}
}

func isAdmin(r *http.Request) bool {
	user := auth.UserFrom(r.Context())
	return user != nil && slices.Contains(user.Roles, "admin")
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func internalError(w http.ResponseWriter, err error) {
	slog.Error("处理请求失败", "err", err)
	writeError(w, http.StatusInternalServerError, "服务器出错了")
}

func fatal(msg string, err error) {
	slog.Error(msg, "err", err)
	os.Exit(1)
}
