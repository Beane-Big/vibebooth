// 人员管理模块后端：维护人员信息，并通过对外接口提供给其他模块。
package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Beane-Big/home-platform/packages/sdk-go/auth"
)

const moduleID = "people"

func main() {
	verifier := auth.NewVerifier(env("JWKS_URL", "http://core:8080/api/platform/.well-known/jwks.json"), moduleID)

	dataDir := env("DATA_DIR", "/data")
	store, err := OpenStore(filepath.Join(dataDir, "people.db"))
	if err != nil {
		fatal("打开数据库失败", err)
	}
	h := &handlers{store: store}

	// 对内接口：只给本模块前端用，需要登录。
	api := http.NewServeMux()
	api.HandleFunc("GET /api/people/persons", h.list)
	api.HandleFunc("POST /api/people/persons", h.create)
	api.HandleFunc("PUT /api/people/persons/{id}", h.update)
	api.HandleFunc("DELETE /api/people/persons/{id}", h.remove)

	mux := http.NewServeMux()
	// 健康检查由平台核心在内部网络直接调用，不经过网关，也不需要令牌。
	mux.HandleFunc("GET /api/people/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	// 对外接口：给其他模块后端在内部网络里直接调用。网关不转发 /api/people/ext/，浏览器访问不到。
	// 目前没有服务令牌，内部网络里的任何容器都能调用，所以只返回其他模块需要的字段（不含备注）。
	mux.HandleFunc("GET /api/people/ext/v1/persons", h.extList)
	mux.HandleFunc("GET /api/people/ext/v1/persons/{id}", h.extGet)
	mux.HandleFunc("PUT /api/people/ext/v1/persons/{id}/photo", h.extSetPhoto)
	mux.Handle("/api/people/", verifier.Middleware(api))

	srv := &http.Server{Addr: ":8000", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	slog.Info("people 模块已启动", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil {
		fatal("服务退出", err)
	}
}

type handlers struct {
	store *Store
}

// ---- 对内接口 ----

func (h *handlers) list(w http.ResponseWriter, r *http.Request) {
	list, err := h.store.List(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *handlers) create(w http.ResponseWriter, r *http.Request) {
	in, ok := readPersonInput(w, r)
	if !ok {
		return
	}
	p, err := h.store.Create(r.Context(), in.Name, in.Note, in.Photo)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (h *handlers) update(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	in, ok := readPersonInput(w, r)
	if !ok {
		return
	}
	p, err := h.store.Update(r.Context(), id, in.Name, in.Note, in.Photo)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (h *handlers) remove(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	err := h.store.Delete(r.Context(), id)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type personInput struct {
	Name  string `json:"name"`
	Note  string `json:"note"`
	Photo string `json:"photo"`
}

// 前端会把照片裁成 320×320 的 JPEG，一般只有几十 KB；这里留足余量并拒绝其他格式。
const (
	photoPrefix  = "data:image/jpeg;base64,"
	maxPhotoSize = 300 << 10
)

func readPersonInput(w http.ResponseWriter, r *http.Request) (personInput, bool) {
	var in personInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPhotoSize+4096)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return in, false
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Note = strings.TrimSpace(in.Note)
	switch {
	case in.Name == "":
		writeError(w, http.StatusBadRequest, "姓名不能为空")
		return in, false
	case utf8.RuneCountInString(in.Name) > 30:
		writeError(w, http.StatusBadRequest, "姓名不能超过 30 个字")
		return in, false
	case utf8.RuneCountInString(in.Note) > 200:
		writeError(w, http.StatusBadRequest, "备注不能超过 200 个字")
		return in, false
	case !validPhoto(in.Photo):
		writeError(w, http.StatusBadRequest, "照片格式不对或太大")
		return in, false
	}
	return in, true
}

// validPhoto 允许空（表示没有照片），或者不超过 maxPhotoSize 的 JPEG data URL。
func validPhoto(photo string) bool {
	return photo == "" || (strings.HasPrefix(photo, photoPrefix) && len(photo) <= maxPhotoSize)
}

// ---- 对外接口 v1（契约见 contracts/openapi.yaml）----

// extPerson 是对外接口返回的人员信息，字段一旦发布就不能删改，只能新增。
type extPerson struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Photo string `json:"photo"`
}

func (h *handlers) extList(w http.ResponseWriter, r *http.Request) {
	list, err := h.store.List(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	out := make([]extPerson, len(list))
	for i, p := range list {
		out[i] = extPerson{ID: p.ID, Name: p.Name, Photo: p.Photo}
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *handlers) extGet(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	p, err := h.store.Get(r.Context(), id)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, extPerson{ID: p.ID, Name: p.Name, Photo: p.Photo})
}

// extSetPhoto 让其他模块（如家庭优化大师）替人员换头像，只能改照片，不能改其他信息。
func (h *handlers) extSetPhoto(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		Photo string `json:"photo"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPhotoSize+4096)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !validPhoto(in.Photo) {
		writeError(w, http.StatusBadRequest, "照片格式不对或太大")
		return
	}
	p, err := h.store.UpdatePhoto(r.Context(), id, in.Photo)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, extPerson{ID: p.ID, Name: p.Name, Photo: p.Photo})
}

// ---- 工具函数 ----

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "id 无效")
		return 0, false
	}
	return id, true
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
	slog.Error("内部错误", "err", err)
	writeError(w, http.StatusInternalServerError, "服务器内部错误")
}

func fatal(msg string, err error) {
	slog.Error(msg, "err", err)
	os.Exit(1)
}
