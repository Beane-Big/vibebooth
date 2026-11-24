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

// contactView 只返回当前账号主动添加的用户资料、私人备注及好友状态，不暴露对方邮箱。
// Name 是人员姓名（没有姓名时为空），前端按 备注 > 姓名 > 账号 显示。
// Status 为 "pending"（待对方确认）或 "accepted"（互为好友）。
type contactView struct {
	ID       int64  `json:"id"`
	UserID   int64  `json:"userId"`
	Name     string `json:"name"`
	Username string `json:"username"`
	Photo    string `json:"photo"`
	Remark   string `json:"remark"`
	Status   string `json:"status"`
}

// contactRequestView 表示别人发给当前账号的待确认好友请求。
type contactRequestView struct {
	ID       int64  `json:"id"`
	UserID   int64  `json:"userId"`
	Name     string `json:"name"`
	Username string `json:"username"`
	Photo    string `json:"photo"`
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
	mux.HandleFunc("GET /api/platform/contacts/requests", s.requireUser(s.handleContactRequests))
	mux.HandleFunc("POST /api/platform/contacts/requests/{id}/accept", s.requireUser(s.handleAcceptContactRequest))
	mux.HandleFunc("POST /api/platform/contacts/requests/{id}/reject", s.requireUser(s.handleRejectContactRequest))
	mux.HandleFunc("PUT /api/platform/contacts/{id}/remark", s.requireUser(s.handleContactRemark))
	mux.HandleFunc("DELETE /api/platform/contacts/{id}", s.requireUser(s.handleDeleteContact))
}

func (s *Server) handleContacts(w http.ResponseWriter, r *http.Request, me *User) {
	w.Header().Set("Cache-Control", "private, no-store")
	rows, err := s.store.pool.Query(r.Context(), `
        SELECT c.id, u.id, u.display_name, u.username, COALESCE(p.photo, ''), c.remark, c.status
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
		err := row.Scan(&item.ID, &item.UserID, &item.Name, &item.Username, &item.Photo, &item.Remark, &item.Status)
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

func (s *Server) handleContactRequests(w http.ResponseWriter, r *http.Request, me *User) {
	w.Header().Set("Cache-Control", "private, no-store")
	rows, err := s.store.pool.Query(r.Context(), `
        SELECT c.id, u.id, u.display_name, u.username, COALESCE(p.photo, '')
        FROM contacts c JOIN users u ON u.id=c.owner_id
        LEFT JOIN persons p ON p.id=u.person_id
        WHERE c.target_user_id=$1 AND c.status='pending' AND NOT u.disabled
        ORDER BY c.created_at DESC, c.id DESC`, me.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (contactRequestView, error) {
		var item contactRequestView
		err := row.Scan(&item.ID, &item.UserID, &item.Name, &item.Username, &item.Photo)
		return item, err
	})
	if err != nil {
		internalError(w, err)
		return
	}
	if items == nil {
		items = []contactRequestView{}
	}
	writeJSON(w, http.StatusOK, items)
}

// handleAddContact 将账号或邮箱精确解析为平台用户，邮箱仅作为查找条件，不代表验证了邮箱归属。
// 若对方已经向自己发过好友请求，则直接双方互为好友；否则创建待对方确认的记录。
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
	tx, err := s.store.pool.Begin(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	defer tx.Rollback(r.Context())

	var reverseID int64
	err = tx.QueryRow(r.Context(), `SELECT id FROM contacts WHERE owner_id=$1 AND target_user_id=$2`, targetID, me.ID).Scan(&reverseID)
	switch {
	case err == nil:
		// 对方已添加过自己：双方直接成为互为好友。
		if _, err = tx.Exec(r.Context(), `UPDATE contacts SET status='accepted' WHERE id=$1`, reverseID); err != nil {
			internalError(w, err)
			return
		}
		_, err = tx.Exec(r.Context(), `INSERT INTO contacts (owner_id, target_user_id, status)
            VALUES ($1, $2, 'accepted')
            ON CONFLICT (owner_id, target_user_id) DO UPDATE SET status='accepted'`, me.ID, targetID)
	case errors.Is(err, pgx.ErrNoRows):
		_, err = tx.Exec(r.Context(), `INSERT INTO contacts (owner_id, target_user_id, status)
            VALUES ($1, $2, 'pending')
            ON CONFLICT (owner_id, target_user_id) DO NOTHING`, me.ID, targetID)
	default:
		internalError(w, err)
		return
	}
	if isForeignKeyViolation(err) {
		writeError(w, http.StatusNotFound, "联系人已不存在")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAcceptContactRequest(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return
	}
	tx, err := s.store.pool.Begin(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	defer tx.Rollback(r.Context())

	var requesterID int64
	err = tx.QueryRow(r.Context(), `UPDATE contacts SET status='accepted'
        WHERE id=$1 AND target_user_id=$2 AND status='pending'
        RETURNING owner_id`, id, me.ID).Scan(&requesterID)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO contacts (owner_id, target_user_id, status)
        VALUES ($1, $2, 'accepted')
        ON CONFLICT (owner_id, target_user_id) DO UPDATE SET status='accepted'`, me.ID, requesterID); err != nil {
		internalError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRejectContactRequest(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return
	}
	tag, err := s.store.pool.Exec(r.Context(), `DELETE FROM contacts
        WHERE id=$1 AND target_user_id=$2 AND status='pending'`, id, me.ID)
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

// handleDeleteContact 移除当前账号的联系人；若双方原本互为好友，同时解除对方的好友记录。
func (s *Server) handleDeleteContact(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return
	}
	tx, err := s.store.pool.Begin(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	defer tx.Rollback(r.Context())

	var targetID int64
	var status string
	err = tx.QueryRow(r.Context(), `DELETE FROM contacts
        WHERE id=$1 AND owner_id=$2 AND target_user_id IS NOT NULL
        RETURNING target_user_id, status`, id, me.ID).Scan(&targetID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	if status == "accepted" {
		if _, err = tx.Exec(r.Context(), `DELETE FROM contacts WHERE owner_id=$1 AND target_user_id=$2`, targetID, me.ID); err != nil {
			internalError(w, err)
			return
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- 对外接口 v1：联系人与按 ID 查询用户资料（契约见 contracts/openapi.yaml）----

type extUser struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Photo       string `json:"photo"`
	Mutual      bool   `json:"mutual,omitempty"`
}

func resolveDisplayName(remark, name, username string) string {
	if s := strings.TrimSpace(remark); s != "" {
		return s
	}
	if s := strings.TrimSpace(name); s != "" {
		return s
	}
	return username
}

// handleExtUserContacts 返回某个账号的联系人列表（?mutual=1 时仅返回互为好友），不暴露全平台人员。
func (s *Server) handleExtUserContacts(w http.ResponseWriter, r *http.Request) {
	ownerID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || ownerID <= 0 {
		writeError(w, http.StatusBadRequest, "用户 id 无效")
		return
	}
	mutualOnly := r.URL.Query().Get("mutual") == "1" || r.URL.Query().Get("mutual") == "true"
	rows, err := s.store.pool.Query(r.Context(), `
        SELECT u.id, u.username, u.display_name, COALESCE(p.photo, ''), c.remark, c.status
        FROM contacts c JOIN users u ON u.id=c.target_user_id
        LEFT JOIN persons p ON p.id=u.person_id
        WHERE c.owner_id=$1 AND NOT u.disabled AND (NOT $2 OR c.status='accepted')
        ORDER BY COALESCE(NULLIF(c.remark, ''), NULLIF(u.display_name, ''), u.username), u.id`, ownerID, mutualOnly)
	if err != nil {
		internalError(w, err)
		return
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (extUser, error) {
		var u extUser
		var remark, status string
		if err := row.Scan(&u.ID, &u.Username, &u.Name, &u.Photo, &remark, &status); err != nil {
			return u, err
		}
		u.DisplayName = resolveDisplayName(remark, u.Name, u.Username)
		u.Mutual = status == "accepted"
		return u, nil
	})
	if err != nil {
		internalError(w, err)
		return
	}
	if items == nil {
		items = []extUser{}
	}
	writeJSON(w, http.StatusOK, items)
}

// handleExtUsers 按指定 ids 批量返回用户基础资料，并按 viewer 的联系人备注解析 displayName。
// 必须提供 ids（最多 200 个），不提供全量人员列表。
func (s *Server) handleExtUsers(w http.ResponseWriter, r *http.Request) {
	rawIDs := strings.TrimSpace(r.URL.Query().Get("ids"))
	if rawIDs == "" {
		writeJSON(w, http.StatusOK, []extUser{})
		return
	}
	parts := strings.Split(rawIDs, ",")
	if len(parts) > 200 {
		writeError(w, http.StatusBadRequest, "单次最多查询 200 个用户")
		return
	}
	seen := make(map[int64]bool, len(parts))
	ids := make([]int64, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		id, err := strconv.ParseInt(p, 10, 64)
		if err != nil || id <= 0 {
			writeError(w, http.StatusBadRequest, "ids 参数无效")
			return
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, []extUser{})
		return
	}
	var viewerID int64
	if v := strings.TrimSpace(r.URL.Query().Get("viewer")); v != "" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil || id <= 0 {
			writeError(w, http.StatusBadRequest, "viewer 无效")
			return
		}
		viewerID = id
	}
	rows, err := s.store.pool.Query(r.Context(), `
        SELECT u.id, u.username, u.display_name, COALESCE(p.photo, ''), COALESCE(c.remark, ''), COALESCE(c.status, '')
        FROM users u
        LEFT JOIN persons p ON p.id=u.person_id
        LEFT JOIN contacts c ON c.owner_id=$2 AND c.target_user_id=u.id
        WHERE u.id = ANY($1) AND NOT u.disabled
        ORDER BY u.id`, ids, viewerID)
	if err != nil {
		internalError(w, err)
		return
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (extUser, error) {
		var u extUser
		var remark, status string
		if err := row.Scan(&u.ID, &u.Username, &u.Name, &u.Photo, &remark, &status); err != nil {
			return u, err
		}
		u.DisplayName = resolveDisplayName(remark, u.Name, u.Username)
		u.Mutual = status == "accepted"
		return u, nil
	})
	if err != nil {
		internalError(w, err)
		return
	}
	if items == nil {
		items = []extUser{}
	}
	writeJSON(w, http.StatusOK, items)
}
