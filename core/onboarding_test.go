package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestSanitizeOnboardingSteps(t *testing.T) {
	got, err := sanitizeOnboardingSteps([]string{" password ", "site", "site", "", "  ", "dev"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"password", "site", "dev"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}

	tooLong := strings.Repeat("a", maxOnboardingStepIDLen+1)
	if _, err := sanitizeOnboardingSteps([]string{tooLong}); err == nil {
		t.Fatal("expected error for overlong step id")
	}

	tooMany := make([]string, maxOnboardingSteps+1)
	for i := range tooMany {
		tooMany[i] = "a"
	}
	if _, err := sanitizeOnboardingSteps(tooMany); err == nil {
		t.Fatal("expected error for too many steps")
	}
}

func TestOnboardingPerUserPersistence(t *testing.T) {
	store := contactTestStore(t)
	ctx := context.Background()
	alice, err := store.CreateUser(ctx, "alice", "Alice", "password123", false)
	if err != nil {
		t.Fatal(err)
	}
	bob, err := store.CreateUser(ctx, "bob", "Bob", "password123", false)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}

	// 初始状态未关闭、无已完成步骤。
	w := httptest.NewRecorder()
	s.handleGetOnboarding(w, httptest.NewRequest(http.MethodGet, "/api/platform/me/onboarding", nil), alice)
	if w.Code != http.StatusOK {
		t.Fatalf("get initial: %d %s", w.Code, w.Body)
	}
	var got OnboardingState
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Dismissed || len(got.Done) != 0 {
		t.Fatalf("unexpected initial state: %+v", got)
	}

	// Alice 关闭指引。
	w = httptest.NewRecorder()
	s.handleSaveOnboarding(
		w,
		httptest.NewRequest(http.MethodPut, "/api/platform/me/onboarding", strings.NewReader(`{"dismissed":true}`)),
		alice,
	)
	if w.Code != http.StatusOK {
		t.Fatalf("dismiss: %d %s", w.Code, w.Body)
	}

	// 仅更新 done 不应重置已关闭的 dismissed 状态。
	w = httptest.NewRecorder()
	s.handleSaveOnboarding(
		w,
		httptest.NewRequest(http.MethodPut, "/api/platform/me/onboarding", strings.NewReader(`{"done":["password","contacts","password"]}`)),
		alice,
	)
	if w.Code != http.StatusOK {
		t.Fatalf("save done: %d %s", w.Code, w.Body)
	}
	got = OnboardingState{}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Dismissed || !slices.Equal(got.Done, []string{"password", "contacts"}) {
		t.Fatalf("unexpected state after partial update: %+v", got)
	}

	// /api/platform/me 应携带当前用户的 onboarding 状态。
	w = httptest.NewRecorder()
	s.handleMe(w, httptest.NewRequest(http.MethodGet, "/api/platform/me", nil), alice)
	if w.Code != http.StatusOK {
		t.Fatalf("me: %d %s", w.Code, w.Body)
	}
	var meResp struct {
		Onboarding OnboardingState `json:"onboarding"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &meResp); err != nil {
		t.Fatal(err)
	}
	if !meResp.Onboarding.Dismissed || !slices.Equal(meResp.Onboarding.Done, []string{"password", "contacts"}) {
		t.Fatalf("unexpected me onboarding: %+v", meResp.Onboarding)
	}

	// Bob 的指引状态独立，不受 Alice 影响。
	w = httptest.NewRecorder()
	s.handleGetOnboarding(w, httptest.NewRequest(http.MethodGet, "/api/platform/me/onboarding", nil), bob)
	if w.Code != http.StatusOK {
		t.Fatalf("bob get: %d %s", w.Code, w.Body)
	}
	got = OnboardingState{}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Dismissed || len(got.Done) != 0 {
		t.Fatalf("bob state leaked: %+v", got)
	}
}
