package main

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

const (
	maxOnboardingSteps     = 50
	maxOnboardingStepIDLen = 64
)

// OnboardingState 是每位登录用户自己的新手指引状态。
// Dismissed 为 true 后门户不再自动展示指引，用户仍可从菜单手动临时打开查看。
type OnboardingState struct {
	Dismissed bool     `json:"dismissed"`
	Done      []string `json:"done"`
}

func (s *Store) OnboardingState(ctx context.Context, userID int64) (OnboardingState, error) {
	state := OnboardingState{Done: []string{}}
	var dismissed bool
	var done []string
	err := s.pool.QueryRow(
		ctx,
		`SELECT dismissed, done_steps FROM user_onboarding WHERE user_id=$1`,
		userID,
	).Scan(&dismissed, &done)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	state.Dismissed = dismissed
	if done != nil {
		state.Done = done
	}
	return state, nil
}

func (s *Store) SaveOnboardingState(ctx context.Context, userID int64, state OnboardingState) (OnboardingState, error) {
	if state.Done == nil {
		state.Done = []string{}
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO user_onboarding (user_id, dismissed, done_steps, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (user_id) DO UPDATE
		SET dismissed = excluded.dismissed,
		    done_steps = excluded.done_steps,
		    updated_at = now()
	`, userID, state.Dismissed, state.Done)
	return state, err
}

func sanitizeOnboardingSteps(in []string) ([]string, error) {
	if len(in) > maxOnboardingSteps {
		return nil, errors.New("已完成步骤条目过多")
	}
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, raw := range in {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if len(id) > maxOnboardingStepIDLen {
			return nil, errors.New("步骤标识过长")
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out, nil
}

func (s *Server) handleGetOnboarding(w http.ResponseWriter, r *http.Request, user *User) {
	state, err := s.store.OnboardingState(r.Context(), user.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *Server) handleSaveOnboarding(w http.ResponseWriter, r *http.Request, user *User) {
	var in struct {
		Dismissed *bool     `json:"dismissed"`
		Done      *[]string `json:"done"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	cur, err := s.store.OnboardingState(r.Context(), user.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	if in.Dismissed != nil {
		cur.Dismissed = *in.Dismissed
	}
	if in.Done != nil {
		clean, err := sanitizeOnboardingSteps(*in.Done)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		cur.Done = clean
	}
	saved, err := s.store.SaveOnboardingState(r.Context(), user.ID, cur)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}
