package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"slices"

	"github.com/Beane-Big/vibebooth/packages/manifest"
	"github.com/Beane-Big/vibebooth/packages/modpkg"
	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

// 模块包上限。一个模块的镜像一般几十 MB，留足余量。
const maxPackageSize = 500 << 20

type server struct {
	installer *Installer
}

// routes 的接口都在 /api/platform/installer/ 下。网关先请平台核心确认是管理员（platform-admin 中间件），
// 这里再用公钥验签并检查 admin 角色，不只信任网关。
func (s *server) routes(verifier *auth.Verifier) http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/platform/installer/modules", s.list)
	api.HandleFunc("POST /api/platform/installer/modules", s.install)
	api.HandleFunc("DELETE /api/platform/installer/modules/{id}", s.uninstall)
	return verifier.Middleware(requireAdmin(api))
}

func requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user := auth.UserFrom(r.Context()); user == nil || !slices.Contains(user.Roles, "admin") {
			writeError(w, http.StatusForbidden, "只有管理员能管理应用", "")
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

// install 接收 multipart 表单里的 package 文件，先存成临时文件再安装。返回安装日志，失败时也返回日志。
// 模块声明了特权时，表单里要有 allowPrivileges=true，否则返回 409 和需要的特权，由门户请管理员确认。
func (s *server) install(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPackageSize)
	file, _, err := r.FormFile("package")
	if err != nil {
		writeError(w, http.StatusBadRequest, "请上传模块包（zip，不超过 500 MB）", "")
		return
	}
	defer file.Close()
	tmp, err := os.CreateTemp("", "package-*.zip")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "保存模块包失败", "")
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
	// 关掉页面或断网时不能中断安装：docker 命令被杀掉后，模块会停在半装好的状态，回滚也跑不了。
	allow := r.FormValue("allowPrivileges") == "true"
	m, err := s.installer.Install(context.WithoutCancel(r.Context()), tmp.Name(), allow, &log)
	if err != nil {
		s.fail(w, err, log.String())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"module": installedView(m), "log": log.String()})
}

func (s *server) uninstall(w http.ResponseWriter, r *http.Request) {
	var log bytes.Buffer
	if err := s.installer.Uninstall(context.WithoutCancel(r.Context()), r.PathValue("id"), r.URL.Query().Get("purge") == "true", &log); err != nil {
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
