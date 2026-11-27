package main

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

const (
	maxHomePrefItems  = 500
	maxHomePrefKeyLen = 80
)

// HomePrefs 是每位登录用户自己的首页应用排序与隐藏列表。
// 键名约定：内置应用为 "builtin:<id>"，模块应用为 "<id>"，避免内置应用与模块同名冲突。
type HomePrefs struct {
	Order  []string `json:"order"`
	Hidden []string `json:"hidden"`
}

func (s *Store) HomePrefs(ctx context.Context, userID int64) (HomePrefs, error) {
	prefs := HomePrefs{Order: []string{}, Hidden: []string{}}
	var order, hidden []string
	err := s.pool.QueryRow(
		ctx,
		`SELECT app_order, hidden_apps FROM user_home_prefs WHERE user_id=$1`,
		userID,
	).Scan(&order, &hidden)
	if errors.Is(err, pgx.ErrNoRows) {
		return prefs, nil
	}
	if err != nil {
		return prefs, err
	}
	if order != nil {
		prefs.Order = order
	}
	if hidden != nil {
		prefs.Hidden = hidden
	}
	return prefs, nil
}

func (s *Store) SaveHomePrefs(ctx context.Context, userID int64, prefs HomePrefs) (HomePrefs, error) {
	if prefs.Order == nil {
		prefs.Order = []string{}
	}
	if prefs.Hidden == nil {
		prefs.Hidden = []string{}
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO user_home_prefs (user_id, app_order, hidden_apps, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (user_id) DO UPDATE
		SET app_order = excluded.app_order,
		    hidden_apps = excluded.hidden_apps,
		    updated_at = now()
	`, userID, prefs.Order, prefs.Hidden)
	return prefs, err
}

func sanitizeHomePrefKeys(in []string) ([]string, error) {
	if len(in) > maxHomePrefItems {
		return nil, errors.New("应用列表条目过多")
	}
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, raw := range in {
		key := strings.TrimSpace(raw)
		if key == "" {
			continue
		}
		if len(key) > maxHomePrefKeyLen {
			return nil, errors.New("应用标识过长")
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out, nil
}

func (s *Server) handleGetHomePrefs(w http.ResponseWriter, r *http.Request, user *User) {
	prefs, err := s.store.HomePrefs(r.Context(), user.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, prefs)
}

func (s *Server) handleSaveHomePrefs(w http.ResponseWriter, r *http.Request, user *User) {
	var in struct {
		Order  *[]string `json:"order"`
		Hidden *[]string `json:"hidden"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	cur, err := s.store.HomePrefs(r.Context(), user.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	if in.Order != nil {
		clean, err := sanitizeHomePrefKeys(*in.Order)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		cur.Order = clean
	}
	if in.Hidden != nil {
		clean, err := sanitizeHomePrefKeys(*in.Hidden)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		cur.Hidden = clean
	}
	saved, err := s.store.SaveHomePrefs(r.Context(), user.ID, cur)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}
