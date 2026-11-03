package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleSite(t *testing.T) {
	s := &Server{cfg: config{ICPBeian: "京ICP备00000000号-1", PoliceBeian: "京公网安备11010000000123号"}}
	w := httptest.NewRecorder()
	s.handleSite(w, httptest.NewRequest(http.MethodGet, "/api/platform/site", nil))
	var got site
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	want := site{ICP: "京ICP备00000000号-1", Police: "京公网安备11010000000123号", PoliceCode: "11010000000123"}
	if w.Code != http.StatusOK || got != want {
		t.Errorf("status %d, got %+v", w.Code, got)
	}
}
