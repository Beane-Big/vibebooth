package main

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type contactView struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Username string `json:"username,omitempty"`
	Email    string `json:"email,omitempty"`
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
	mux.HandleFunc("DELETE /api/platform/contacts/{id}", s.requireUser(s.handleDeleteContact))
}

func (s *Server) handleContacts(w http.ResponseWriter, r *http.Request, me *User) {
	w.Header().Set("Cache-Control", "private, no-store")
	rows, err := s.store.pool.Query(r.Context(), `
		SELECT c.id, COALESCE(NULLIF(u.display_name, ''), u.username, p.name, c.email),
		       COALESCE(u.username, ''), COALESCE(c.email, '')
		FROM contacts c
		LEFT JOIN users u ON u.id=c.target_user_id
		LEFT JOIN persons p ON p.id=c.target_person_id
		WHERE c.owner_id=$1
		ORDER BY 2, c.id`, me.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (contactView, error) {
		var item contactView
		err := row.Scan(&item.ID, &item.Name, &item.Username, &item.Email)
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
	ctx := r.Context()
	var targetID int64
	var personID *int64
	var err error
	email := normalizeEmail(identifier)
	if email == "" {
		if !usernamePattern.MatchString(identifier) {
			writeError(w, http.StatusBadRequest, "请输入有效的账号或邮箱")
			return
		}
		err = s.store.pool.QueryRow(ctx, `SELECT id, person_id FROM users WHERE username=$1 AND NOT disabled`, identifier).Scan(&targetID, &personID)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "没有找到该账号")
			return
		}
	} else {
		err = s.store.pool.QueryRow(ctx, `SELECT id, person_id FROM users WHERE email=$1 AND email_verified AND NOT disabled`, email).Scan(&targetID, &personID)
		if errors.Is(err, pgx.ErrNoRows) {
			// 未验证的地址只保存为通讯录条目，不推断账号归属。
			err = nil
		}
	}
	if err != nil {
		internalError(w, err)
		return
	}
	if targetID == me.ID {
		writeError(w, http.StatusBadRequest, "不能添加自己")
		return
	}

	if targetID == 0 {
		_, err = s.store.pool.Exec(ctx, `INSERT INTO contacts (owner_id, email) VALUES ($1,$2) ON CONFLICT DO NOTHING`, me.ID, email)
	} else {
		// 用明确选择的账号替换已迁移的同一人员，避免同时显示两条。
		_, err = s.store.pool.Exec(ctx, `
			WITH added AS (
				INSERT INTO contacts (owner_id, target_user_id) VALUES ($1,$2)
				ON CONFLICT DO NOTHING RETURNING id
			)
			DELETE FROM contacts WHERE owner_id=$1 AND
				(target_person_id=$3 OR email=NULLIF($4, '')) AND EXISTS (SELECT 1 FROM added)`,
			me.ID, targetID, personID, email)
	}
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

func (s *Server) handleDeleteContact(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return
	}
	tag, err := s.store.pool.Exec(r.Context(), `DELETE FROM contacts WHERE id=$1 AND owner_id=$2`, id, me.ID)
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
