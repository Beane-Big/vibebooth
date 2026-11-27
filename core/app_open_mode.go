package main

import (
	"context"
	"net/http"

	"github.com/Beane-Big/vibebooth/packages/manifest"
)

const (
	openModePortal = "portal"
	openModeNewTab = "new-tab"
)

func normalizeOpenMode(mode string) string {
	if mode == openModeNewTab {
		return openModeNewTab
	}
	return openModePortal
}

func (s *Store) appOpenModes(ctx context.Context) (map[string]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT module_id, open_mode FROM app_open_modes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]string)
	for rows.Next() {
		var id, mode string
		if err := rows.Scan(&id, &mode); err != nil {
			return nil, err
		}
		result[id] = normalizeOpenMode(mode)
	}
	return result, rows.Err()
}

func (s *Store) setAppOpenMode(ctx context.Context, moduleID, mode string) error {
	if mode == openModePortal {
		_, err := s.pool.Exec(ctx, `DELETE FROM app_open_modes WHERE module_id=$1`, moduleID)
		return err
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO app_open_modes (module_id, open_mode) VALUES ($1,$2)
		ON CONFLICT (module_id) DO UPDATE SET open_mode=excluded.open_mode`, moduleID, mode)
	return err
}

func (s *Server) handleAppOpenModes(w http.ResponseWriter, r *http.Request, _ *User) {
	modes, err := s.store.appOpenModes(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	result := make(map[string]string)
	for _, m := range s.registry.List() {
		if _, frontend := m.Services[manifest.Frontend]; frontend {
			result[m.ID] = normalizeOpenMode(modes[m.ID])
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleSetAppOpenMode(w http.ResponseWriter, r *http.Request, _ *User) {
	m, ok := s.registry.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "应用不存在")
		return
	}
	if _, frontend := m.Services[manifest.Frontend]; !frontend {
		writeError(w, http.StatusBadRequest, "此应用没有网页入口")
		return
	}
	var in struct {
		OpenMode string `json:"openMode"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.OpenMode != openModePortal && in.OpenMode != openModeNewTab {
		writeError(w, http.StatusBadRequest, "无效的打开方式")
		return
	}
	if err := s.store.setAppOpenMode(r.Context(), m.ID, in.OpenMode); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
