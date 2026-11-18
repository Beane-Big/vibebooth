package main

import (
	"context"
	"errors"
	"net/http"
	"path"
	"strings"

	"github.com/Beane-Big/vibebooth/packages/manifest"
	"github.com/jackc/pgx/v5"
)

const (
	scopeRestricted = "restricted"
	scopePublic     = "public"
	scopeSignedIn   = "signed-in"
)

type appAccess struct {
	Version string `json:"version"`
	Scope   string `json:"scope"`
}

func (a appAccess) forModule(m *Module) string {
	if a.Version == m.Version && a.Scope != "" {
		return a.Scope
	}
	return scopeRestricted
}

func canBrowseApp(m *Module, scope string, signedIn bool) bool {
	_, frontend := m.Services[manifest.Frontend]
	return frontend && (scope == scopePublic || signedIn && scope == scopeSignedIn)
}

func publicFrontendRequest(m *Module, requestPath, method string) bool {
	if method != http.MethodGet && method != http.MethodHead {
		return false
	}
	// Only canonical paths under the module's frontend prefix may bypass sign-in.
	if !strings.HasPrefix(requestPath, m.FrontendPath()) || strings.ContainsAny(requestPath, "%\\") {
		return false
	}
	return path.Clean(requestPath) == strings.TrimSuffix(requestPath, "/")
}

func (s *Store) appScope(ctx context.Context, m *Module) (string, error) {
	var access appAccess
	err := s.pool.QueryRow(ctx, `SELECT version, scope FROM app_access WHERE module_id=$1`, m.ID).Scan(&access.Version, &access.Scope)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return access.forModule(m), err
}

func (s *Store) appScopes(ctx context.Context) (map[string]appAccess, error) {
	rows, err := s.pool.Query(ctx, `SELECT module_id, version, scope FROM app_access`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]appAccess)
	for rows.Next() {
		var id string
		var a appAccess
		if err := rows.Scan(&id, &a.Version, &a.Scope); err != nil {
			return nil, err
		}
		result[id] = a
	}
	return result, rows.Err()
}

func (s *Server) handleAppAccess(w http.ResponseWriter, r *http.Request, _ *User) {
	access, err := s.store.appScopes(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	result := make(map[string]appAccess)
	for _, m := range s.registry.List() {
		if _, frontend := m.Services[manifest.Frontend]; frontend {
			result[m.ID] = appAccess{Version: m.Version, Scope: access[m.ID].forModule(m)}
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleSetAppAccess(w http.ResponseWriter, r *http.Request, _ *User) {
	m, ok := s.registry.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "应用不存在")
		return
	}
	if _, frontend := m.Services[manifest.Frontend]; !frontend {
		writeError(w, http.StatusBadRequest, "此应用没有网页入口")
		return
	}
	var in appAccess
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Version != m.Version {
		writeError(w, http.StatusConflict, "应用版本已变化，请刷新后重试")
		return
	}
	var err error
	switch in.Scope {
	case scopeRestricted:
		_, err = s.store.pool.Exec(r.Context(), `DELETE FROM app_access WHERE module_id=$1`, m.ID)
	case scopePublic, scopeSignedIn:
		_, err = s.store.pool.Exec(r.Context(), `INSERT INTO app_access (module_id, version, scope) VALUES ($1,$2,$3)
			ON CONFLICT (module_id) DO UPDATE SET version=excluded.version, scope=excluded.scope`, m.ID, m.Version, in.Scope)
	default:
		writeError(w, http.StatusBadRequest, "无效的访问范围")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
