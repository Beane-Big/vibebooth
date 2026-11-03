package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleSite(t *testing.T) {
	s := &Server{cfg: config{ICPBeian: "陕ICP备2026031607号-1", PoliceBeian: "陕公网安备61010202000123号"}}
	w := httptest.NewRecorder()
	s.handleSite(w, httptest.NewRequest(http.MethodGet, "/api/platform/site", nil))
	var got site
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	want := site{ICP: "陕ICP备2026031607号-1", Police: "陕公网安备61010202000123号", PoliceCode: "61010202000123"}
	if w.Code != http.StatusOK || got != want {
		t.Errorf("status %d, got %+v", w.Code, got)
	}
}
