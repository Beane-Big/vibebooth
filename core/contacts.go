package main

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// contactView 只返回当前账号主动添加的用户资料及其私人备注，不暴露对方邮箱。
// Name 是人员姓名（没有姓名时为空），前端按 备注 > 姓名 > 账号 显示。
type contactView struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Username string `json:"username"`
	Photo    string `json:"photo"`
	Remark   string `json:"remark"`
}

func (s *Server) mountContacts(mux *http.ServeMux) {
	attempts := newLoginLimiter(30, 15*time.Minute)
	mux.HandleFunc("GET /api/platform/contacts", s.requireUser(s.handleContacts))
	mux.HandleFunc("POST /api/platform/contacts", s.requireUser(func(w http.ResponseWriter, r *http.Request, me *User) {
		key := strconv.FormatInt(me.ID, 10)
		if !attempts.Allow(key) {
			writeError(w, http.StatusTooManyRequests, "添加过于频繁，请稍后再试")
			return
		}
		attempts.Fail(key)
		s.handleAddContact(w, r, me)
	}))
	mux.HandleFunc("PUT /api/platform/contacts/{id}/remark", s.requireUser(s.handleContactRemark))
	mux.HandleFunc("DELETE /api/platform/contacts/{id}", s.requireUser(s.handleDeleteContact))
}

func (s *Server) handleContacts(w http.ResponseWriter, r *http.Request, me *User) {
	w.Header().Set("Cache-Control", "private, no-store")
	rows, err := s.store.pool.Query(r.Context(), `
        SELECT c.id, u.display_name, u.username, COALESCE(p.photo, ''), c.remark
        FROM contacts c JOIN users u ON u.id=c.target_user_id
        LEFT JOIN persons p ON p.id=u.person_id
        WHERE c.owner_id=$1 AND NOT u.disabled
        ORDER BY COALESCE(NULLIF(u.display_name, ''), u.username), c.id`, me.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (contactView, error) {
		var item contactView
		err := row.Scan(&item.ID, &item.Name, &item.Username, &item.Photo, &item.Remark)
		return item, err
	})
	if err != nil {
		internalError(w, err)
		return
	}
	if items == nil {
		items = []contactView{}
	}
	writeJSON(w, http.StatusOK, items)
}

// handleAddContact 将账号或邮箱精确解析为平台用户，邮箱仅作为查找条件，不代表验证了邮箱归属。
func (s *Server) handleAddContact(w http.ResponseWriter, r *http.Request, me *User) {
	var in struct {
		Identifier string `json:"identifier"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	identifier := strings.TrimSpace(in.Identifier)
	if identifier == "" {
		writeError(w, http.StatusBadRequest, "请输入账号或邮箱")
		return
	}
	email := normalizeEmail(identifier)
	if email == "" && !usernamePattern.MatchString(identifier) {
		writeError(w, http.StatusBadRequest, "请输入有效的账号或邮箱")
		return
	}
	// 同一邮箱添加和账号添加最终使用同一个用户 ID，数据库唯一约束避免重复。
	var targetID int64
	err := s.store.pool.QueryRow(r.Context(), `SELECT id FROM users
        WHERE NOT disabled AND (($1<>'' AND email=$1) OR ($1='' AND username=$2))`,
		email, identifier).Scan(&targetID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有找到该用户")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	if targetID == me.ID {
		writeError(w, http.StatusBadRequest, "不能添加自己")
		return
	}
	_, err = s.store.pool.Exec(r.Context(), `INSERT INTO contacts (owner_id, target_user_id)
        VALUES ($1,$2) ON CONFLICT (owner_id, target_user_id) DO NOTHING`, me.ID, targetID)
	if isForeignKeyViolation(err) {
		writeError(w, http.StatusNotFound, "联系人已不存在")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleContactRemark 只更新当前账号拥有的联系人，空值用于清除自己的备注。
func (s *Server) handleContactRemark(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
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
	tx, err := s.store.pool.Begin(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var personID *int64
	err = tx.QueryRow(r.Context(), `UPDATE contacts c SET remark=$3 FROM users u
        WHERE c.id=$1 AND c.owner_id=$2 AND u.id=c.target_user_id AND NOT u.disabled
        RETURNING u.person_id`, id, me.ID, in.Remark).Scan(&personID)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	// 保持原成员备注对外接口的兼容，第三方应用仍可读取当前用户给关联人员写的备注。
	if err == nil && personID != nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO person_remarks (user_id, person_id, remark)
            VALUES ($1,$2,$3) ON CONFLICT (user_id, person_id) DO UPDATE SET remark=excluded.remark`,
			me.ID, *personID, in.Remark)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteContact(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return
	}
	tag, err := s.store.pool.Exec(r.Context(), `DELETE FROM contacts WHERE id=$1 AND owner_id=$2 AND target_user_id IS NOT NULL`, id, me.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		http.NotFound(w, r)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
