package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	neturl "net/url"
	"os"
	"slices"
	"strings"

	"github.com/Beane-Big/vibebooth/packages/manifest"
	"github.com/Beane-Big/vibebooth/packages/modpkg"
	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

// 模块包上限。一般的模块几十 MB，带模型的模块（例如背单词的语音）有几百 MB，留足余量。
// 上传这么大的包要很久，网关和安装器读请求的超时也相应放宽了（docker-compose.yml、main.go）。
const maxPackageSize = 2 << 30

type server struct {
	installer *Installer
}

// routes 的接口都在 /api/platform/installer/ 下。网关先请平台核心确认有“应用管理”权限（platform-admin 中间件），
// 这里再用公钥验签并检查令牌里的权限，不只信任网关。
func (s *server) routes(verifier *auth.Verifier) http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/platform/installer/modules", s.list)
	api.HandleFunc("POST /api/platform/installer/modules", s.install)
	api.HandleFunc("DELETE /api/platform/installer/modules/{id}", s.uninstall)
	api.HandleFunc("POST /api/platform/installer/themes", s.installTheme)
	api.HandleFunc("DELETE /api/platform/installer/themes/{id}", s.uninstallTheme)
	return verifier.Middleware(requireModulesPerm(api))
}

// requireModulesPerm 只放行有平台“应用管理”权限的令牌。旧平台核心签发的令牌没有 perms，只认 admin 角色。
func requireModulesPerm(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user := auth.UserFrom(r.Context()); user == nil || !(user.Has("modules") || slices.Contains(user.Roles, "admin")) {
			writeError(w, http.StatusForbidden, "没有应用管理权限", "")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) list(w http.ResponseWriter, r *http.Request) {
	list, err := s.installer.List(r.Context())
	if err != nil {
		slog.Error("读取已安装模块失败", "err", err)
		writeError(w, http.StatusInternalServerError, "读取已安装模块失败", "")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// install 安装或升级模块，multipart 表单里二选一：
//   - package：上传的模块包文件，边收边存成临时文件；
//   - url：模块包的下载地址，由安装器自己去下载。构建器用它把服务器上构建好的软件包直接交给安装器，不经过浏览器。
//
// 返回安装日志，失败时也返回日志。模块声明了特权时，表单里要有 allowPrivileges=true，
// 否则返回 409 和需要的特权，由门户请管理员确认。
func (s *server) install(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPackageSize+1<<20)
	path, allow, status, err := s.receivePackage(r)
	if path != "" {
		defer os.Remove(path)
	}
	if err != nil {
		writeError(w, status, err.Error(), "")
		return
	}

	var log bytes.Buffer
	// 关掉页面或断网时不能中断安装：docker 命令被杀掉后，模块会停在半装好的状态，回滚也跑不了。
	m, err := s.installer.Install(context.WithoutCancel(r.Context()), path, allow, &log)
	if err != nil {
		s.fail(w, err, log.String())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"module": installedView(m), "log": log.String()})
}

// receivePackage 读安装表单，把模块包存成临时文件，返回文件路径和是否允许特权。出错时返回给管理员看的错误和状态码；
// 返回的路径不为空时，由调用方删除临时文件。用 MultipartReader 边收边写，几百 MB 的包不会先整个缓存一遍。
func (s *server) receivePackage(r *http.Request) (path string, allow bool, status int, err error) {
	usage := fmt.Errorf("请上传模块包（zip，不超过 %d MB），或者给出模块包的下载地址", maxPackageSize>>20)
	mr, err := r.MultipartReader()
	if err != nil {
		return "", false, http.StatusBadRequest, usage
	}
	var url string
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return path, false, uploadStatus(err), uploadError(err)
		}
		switch part.FormName() {
		case "package":
			if path != "" {
				return path, false, http.StatusBadRequest, usage
			}
			if path, err = saveTemp(part); err != nil {
				return path, false, uploadStatus(err), uploadError(err)
			}
		case "url", "allowPrivileges":
			v, err := io.ReadAll(io.LimitReader(part, 4<<10))
			if err != nil {
				return path, false, uploadStatus(err), uploadError(err)
			}
			if part.FormName() == "url" {
				url = strings.TrimSpace(string(v))
			} else {
				allow = string(v) == "true"
			}
		}
	}
	switch {
	case path != "" && url == "":
		return path, allow, 0, nil
	case path == "" && url != "":
		path, err = fetchPackage(r.Context(), url)
		if err != nil {
			return path, false, http.StatusBadRequest, err
		}
		return path, allow, 0, nil
	}
	return path, false, http.StatusBadRequest, usage
}

// fetchPackage 下载模块包到临时文件。只有管理员能调用安装接口，管理员本来就能装任意模块，所以不限制下载地址的主机。
func fetchPackage(ctx context.Context, rawURL string) (string, error) {
	if u, err := neturl.Parse(rawURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("模块包的下载地址要以 http:// 或 https:// 开头")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", errors.New("模块包的下载地址不对")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("下载模块包失败：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载模块包失败：%s", resp.Status)
	}
	path, err := saveTemp(&limitedReader{r: resp.Body, n: maxPackageSize})
	if err != nil {
		if errors.Is(err, errTooLarge) {
			return path, fmt.Errorf("模块包不能超过 %d MB", maxPackageSize>>20)
		}
		return path, fmt.Errorf("下载模块包中断：%v", err)
	}
	return path, nil
}

// saveTemp 把 r 的内容存成临时文件。出错时也返回已经建好的文件路径，由调用方删除。
func saveTemp(r io.Reader) (string, error) {
	tmp, err := os.CreateTemp("", "package-*.zip")
	if err != nil {
		return "", err
	}
	_, err = io.Copy(tmp, r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	return tmp.Name(), err
}

var errTooLarge = errors.New("模块包太大")

// limitedReader 读到超过 n 字节时报 errTooLarge，而不是像 io.LimitReader 那样悄悄截断。
type limitedReader struct {
	r io.Reader
	n int64
}

func (l *limitedReader) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	if l.n -= int64(n); l.n < 0 {
		return n, errTooLarge
	}
	return n, err
}

func uploadStatus(err error) int {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}

func uploadError(err error) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return fmt.Errorf("模块包不能超过 %d MB", maxPackageSize>>20)
	}
	return errors.New("上传中断，请重试")
}

func (s *server) uninstall(w http.ResponseWriter, r *http.Request) {
	var log bytes.Buffer
	if err := s.installer.Uninstall(context.WithoutCancel(r.Context()), r.PathValue("id"), r.URL.Query().Get("purge") == "true", &log); err != nil {
		s.fail(w, err, log.String())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"log": log.String()})
}

// installTheme 接收 multipart 表单里的 package 文件（主题包 zip）。主题带脚本，在门户里以使用者的身份运行，
// 所以和特权模块一样要管理员确认：表单里没有 allowScript=true 时返回 409，由门户弹窗确认。
func (s *server) installTheme(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxThemePackage)
	file, _, err := r.FormFile("package")
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("请上传主题包（zip，不超过 %d MB）", maxThemePackage>>20), "")
		return
	}
	defer file.Close()
	tmp, err := os.CreateTemp("", "theme-*.zip")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "保存主题包失败", "")
		return
	}
	defer os.Remove(tmp.Name())
	_, err = io.Copy(tmp, file)
	tmp.Close()
	if err != nil {
		writeError(w, http.StatusBadRequest, "上传中断，请重试", "")
		return
	}
	var log bytes.Buffer
	t, err := s.installer.InstallTheme(tmp.Name(), r.FormValue("allowScript") == "true", &log)
	if err != nil {
		s.fail(w, err, log.String())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"theme": t, "log": log.String()})
}

func (s *server) uninstallTheme(w http.ResponseWriter, r *http.Request) {
	var log bytes.Buffer
	if err := s.installer.UninstallTheme(r.PathValue("id"), &log); err != nil {
		s.fail(w, err, log.String())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"log": log.String()})
}

// fail 把模块包不合规范的错误原样告诉管理员；其他错误记日志，并把安装日志一起返回方便排查。
func (s *server) fail(w http.ResponseWriter, err error, log string) {
	var priv *PrivilegeError
	if errors.As(err, &priv) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": priv.Error(), "privileges": priv.Privileges})
		return
	}
	var script *ScriptError
	if errors.As(err, &script) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": script.Error(), "script": true})
		return
	}
	var inv *modpkg.InvalidError
	if errors.As(err, &inv) {
		writeError(w, http.StatusBadRequest, inv.Error(), log)
		return
	}
	slog.Error("操作失败", "err", err)
	writeError(w, http.StatusInternalServerError, err.Error(), log)
}

func installedView(m *manifest.Manifest) Installed {
	return Installed{
		ID: m.ID, Name: m.Name, Description: m.Description, Version: m.Version,
		Requires: orEmpty(m.RequiredIDs()), Optional: orEmpty(depIDs(m.OptionalDeps)),
		RequiredBy: []string{}, Privileges: orEmpty(m.Privileges), Healthy: true,
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg, log string) {
	body := map[string]string{"error": msg}
	if log != "" {
		body["log"] = log
	}
	writeJSON(w, status, body)
}
