package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ---- 人员管理（只有管理员能用，门户“用户”应用调用）----

type personInput struct {
	Name  string `json:"name"`
	Note  string `json:"note"`
	Photo string `json:"photo"`
}

// 门户会把照片裁成 320×320 的 JPEG，一般只有几十 KB；这里留足余量并拒绝其他格式。
const (
	photoPrefix  = "data:image/jpeg;base64,"
	maxPhotoSize = 300 << 10
)

// validPhoto 允许空（表示没有照片），或者不超过 maxPhotoSize 的 JPEG data URL。
func validPhoto(photo string) bool {
	return photo == "" || (strings.HasPrefix(photo, photoPrefix) && len(photo) <= maxPhotoSize)
}

// decodePhotoJSON 和 decodeJSON 一样，只是请求里可能带照片，允许的大小放宽到照片上限。
func decodePhotoJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPhotoSize+4096)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return false
	}
	return true
}

func readPersonInput(w http.ResponseWriter, r *http.Request) (personInput, bool) {
	var in personInput
	if !decodePhotoJSON(w, r, &in) {
		return in, false
	}
	in.Name, in.Note = strings.TrimSpace(in.Name), strings.TrimSpace(in.Note)
	switch {
	case in.Name == "":
		writeError(w, http.StatusBadRequest, "姓名不能为空")
	case utf8.RuneCountInString(in.Name) > 30:
		writeError(w, http.StatusBadRequest, "姓名不能超过 30 个字")
	case utf8.RuneCountInString(in.Note) > 200:
		writeError(w, http.StatusBadRequest, "备注不能超过 200 个字")
	case !validPhoto(in.Photo):
		writeError(w, http.StatusBadRequest, "照片格式不对或太大")
	default:
		return in, true
	}
	return in, false
}

// personID 取路径里的 id；无效时已经写好 404。
func personID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusNotFound, errPersonNotFound.Error())
		return 0, false
	}
	return id, true
}

// personFailed 处理查询或修改人员的错误：人员不存在时写 404，其他错误写 500。没有错误时返回 false。
func personFailed(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, errPersonNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case err != nil:
		internalError(w, err)
	default:
		return false
	}
	return true
}

func (s *Server) handleListPersons(w http.ResponseWriter, r *http.Request, _ *User) {
	list, err := s.store.ListPersons(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreatePerson(w http.ResponseWriter, r *http.Request, _ *User) {
	in, ok := readPersonInput(w, r)
	if !ok {
		return
	}
	p, err := s.store.CreatePerson(r.Context(), in.Name, in.Note, in.Photo)
	if !personFailed(w, err) {
		writeJSON(w, http.StatusCreated, p)
	}
}

func (s *Server) handleUpdatePerson(w http.ResponseWriter, r *http.Request, _ *User) {
	id, ok := personID(w, r)
	if !ok {
		return
	}
	in, ok := readPersonInput(w, r)
	if !ok {
		return
	}
	p, err := s.store.UpdatePerson(r.Context(), id, in.Name, in.Note, in.Photo)
	if !personFailed(w, err) {
		writeJSON(w, http.StatusOK, p)
	}
}

func (s *Server) handleDeletePerson(w http.ResponseWriter, r *http.Request, _ *User) {
	id, ok := personID(w, r)
	if !ok {
		return
	}
	if !personFailed(w, s.store.DeletePerson(r.Context(), id)) {
		w.WriteHeader(http.StatusNoContent)
	}
}

// ---- 成员备注（有平台“成员”权限的人用，管理员也能用）----

func (s *Server) handleListMembers(w http.ResponseWriter, r *http.Request, me *User) {
	list, err := s.store.ListMembers(r.Context(), me.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleSetRemark 保存自己给一个成员写的备注，空字符串表示删除。
func (s *Server) handleSetRemark(w http.ResponseWriter, r *http.Request, me *User) {
	id, ok := personID(w, r)
	if !ok {
		return
	}
	var in struct {
		Remark string `json:"remark"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Remark = strings.TrimSpace(in.Remark)
	if utf8.RuneCountInString(in.Remark) > 200 {
		writeError(w, http.StatusBadRequest, "备注不能超过 200 个字")
		return
	}
	if !personFailed(w, s.store.SetRemark(r.Context(), me.ID, id, in.Remark)) {
		w.WriteHeader(http.StatusNoContent)
	}
}

// ---- 对外接口 v1（契约见 contracts/openapi.yaml）----

// extPerson 是对外接口返回的人员信息，字段一旦发布就不能删改，只能新增。备注不对外。
type extPerson struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Photo string `json:"photo"`
}

func toExt(p *Person) extPerson { return extPerson{ID: p.ID, Name: p.Name, Photo: p.Photo} }

func (s *Server) handleExtPersons(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListPersons(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	out := make([]extPerson, len(list))
	for i := range list {
		out[i] = toExt(&list[i])
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleExtPerson(w http.ResponseWriter, r *http.Request) {
	id, ok := personID(w, r)
	if !ok {
		return
	}
	p, err := s.store.PersonByID(r.Context(), id)
	if !personFailed(w, err) {
		writeJSON(w, http.StatusOK, toExt(p))
	}
}

// handleExtSetPhoto 让模块（如家庭优化大师）替人员换头像，只能改照片，不能改其他信息。
func (s *Server) handleExtSetPhoto(w http.ResponseWriter, r *http.Request) {
	id, ok := personID(w, r)
	if !ok {
		return
	}
	var in struct {
		Photo string `json:"photo"`
	}
	if !decodePhotoJSON(w, r, &in) {
		return
	}
	if !validPhoto(in.Photo) {
		writeError(w, http.StatusBadRequest, "照片格式不对或太大")
		return
	}
	p, err := s.store.UpdatePersonPhoto(r.Context(), id, in.Photo)
	if !personFailed(w, err) {
		writeJSON(w, http.StatusOK, toExt(p))
	}
}

// handleExtUserPerson 让模块知道当前登录的是谁：账号 id 就是模块令牌里的 sub。
func (s *Server) handleExtUserPerson(w http.ResponseWriter, r *http.Request) {
	id, ok := personID(w, r)
	if !ok {
		return
	}
	p, err := s.store.PersonByUser(r.Context(), id)
	if !personFailed(w, err) {
		writeJSON(w, http.StatusOK, toExt(p))
	}
}
