// 家庭优化大师模块后端：保存每个人的分数，人员名单和照片来自人员管理模块。
package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"github.com/Beane-Big/home-platform/packages/sdk-go/auth"
)

const moduleID = "family"

func main() {
	verifier := auth.NewVerifier(env("JWKS_URL", "http://core:8080/api/platform/.well-known/jwks.json"), moduleID)

	store, err := OpenStore(filepath.Join(env("DATA_DIR", "/data"), "family.db"))
	if err != nil {
		fatal("打开数据库失败", err)
	}
	h := &handlers{store: store, people: newPeopleClient(env("PEOPLE_URL", "http://people-backend:8000"))}

	// 对内接口：只给本模块前端用，需要登录。
	api := http.NewServeMux()
	api.HandleFunc("GET /api/family/scores", h.board)
	api.HandleFunc("POST /api/family/scores/{personId}", h.change)
	api.HandleFunc("PUT /api/family/members/{personId}/photo", h.setPhoto)
	// 清零属于设置，只有有“设置”菜单的人能做；门户只是对他们显示设置入口，权限以这里为准。
	api.HandleFunc("DELETE /api/family/scores", requireMenu("settings", h.reset))

	mux := http.NewServeMux()
	// 健康检查由平台核心在内部网络直接调用，不经过网关，也不需要令牌。
	mux.HandleFunc("GET /api/family/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/api/family/", verifier.Middleware(api))

	srv := &http.Server{Addr: ":8000", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	slog.Info("family 模块已启动", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil {
		fatal("服务退出", err)
	}
}

type handlers struct {
	store  *Store
	people *peopleClient
}

type member struct {
	PersonID int64  `json:"personId"`
	Name     string `json:"name"`
	Photo    string `json:"photo"`
	Score    int    `json:"score"`
}

type boardView struct {
	Members []member `json:"members"`
	// PeopleAvailable 为 false 表示人员模块暂时不可用，Members 里只有分数、没有姓名和照片。
	PeopleAvailable bool `json:"peopleAvailable"`
}

// board 以人员模块的名单为准：新加的人从 0 分开始，已删除的人不再显示。按分数从高到低排列。
func (h *handlers) board(w http.ResponseWriter, r *http.Request) {
	scores, err := h.store.Scores(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	view := boardView{Members: []member{}, PeopleAvailable: true}
	people, err := h.people.List(r.Context())
	if err != nil {
		slog.Warn("获取人员列表失败，降级为只显示分数", "err", err)
		view.PeopleAvailable = false
		for id, score := range scores {
			view.Members = append(view.Members, member{PersonID: id, Score: score})
		}
	} else {
		for _, p := range people {
			view.Members = append(view.Members, member{PersonID: p.ID, Name: p.Name, Photo: p.Photo, Score: scores[p.ID]})
		}
	}
	sort.SliceStable(view.Members, func(i, j int) bool {
		a, b := view.Members[i], view.Members[j]
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		return a.PersonID < b.PersonID
	})
	writeJSON(w, http.StatusOK, view)
}

// change 给一个人加减分。前端会把长按连续产生的多次加减合并成一次请求，所以 delta 可能大于 1。
func (h *handlers) change(w http.ResponseWriter, r *http.Request) {
	personID, err := strconv.ParseInt(r.PathValue("personId"), 10, 64)
	if err != nil || personID <= 0 {
		writeError(w, http.StatusBadRequest, "personId 无效")
		return
	}
	var in struct {
		Delta int `json:"delta"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if in.Delta == 0 || in.Delta < -1000 || in.Delta > 1000 {
		writeError(w, http.StatusBadRequest, "单次加减分要在 -1000 到 1000 之间，且不能为 0")
		return
	}
	// 只给人员模块里存在的人打分，避免写入无主的分数。
	if _, err := h.people.Get(r.Context(), personID); err != nil {
		if errors.Is(err, errPersonNotFound) {
			writeError(w, http.StatusNotFound, "人员不存在")
			return
		}
		slog.Warn("查询人员失败", "err", err)
		writeError(w, http.StatusServiceUnavailable, "人员管理暂时不可用，请稍后再试")
		return
	}
	score, err := h.store.Change(r.Context(), personID, in.Delta)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"personId": personID, "score": score})
}

// setPhoto 在记分板上点头像换照片；照片写回人员管理模块，其他应用也会看到新头像。
func (h *handlers) setPhoto(w http.ResponseWriter, r *http.Request) {
	personID, err := strconv.ParseInt(r.PathValue("personId"), 10, 64)
	if err != nil || personID <= 0 {
		writeError(w, http.StatusBadRequest, "personId 无效")
		return
	}
	var in struct {
		Photo string `json:"photo"`
	}
	// 照片由前端压缩到几十 KB，人员模块限制 300 KB，这里留一点余量。
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 320<<10)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	p, err := h.people.SetPhoto(r.Context(), personID, in.Photo)
	switch {
	case errors.Is(err, errPersonNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, errInvalidPhoto):
		writeError(w, http.StatusBadRequest, err.Error())
	case err != nil:
		slog.Warn("修改头像失败", "err", err)
		writeError(w, http.StatusServiceUnavailable, "人员管理暂时不可用，请稍后再试")
	default:
		writeJSON(w, http.StatusOK, map[string]any{"personId": p.ID, "photo": p.Photo})
	}
}

func (h *handlers) reset(w http.ResponseWriter, r *http.Request) {
	if err := h.store.Reset(r.Context()); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- 工具函数 ----

// requireMenu 要求当前用户有某个菜单的权限，菜单由管理员在门户“用户”页按人设置。
func requireMenu(menu string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !auth.UserFrom(r.Context()).HasMenu(menu) {
			writeError(w, http.StatusForbidden, "没有修改设置的权限")
			return
		}
		next(w, r)
	}
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
