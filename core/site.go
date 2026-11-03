package main

import (
	"net/http"
	"strings"
)

// site 是站点的公开信息，登录前也能取到：门户所有页面（含登录页）的底部显示备案号。
// ICP 是 ICP 备案号（例如“陕ICP备2026031607号-1”），Police 是公安备案号（例如“陕公网安备61010000000000号”），
// PoliceCode 是公安备案号里的数字，用来拼公安备案查询的链接。都由 .env 配置，留空就不显示。
type site struct {
	ICP        string `json:"icp"`
	Police     string `json:"police"`
	PoliceCode string `json:"policeCode"`
}

func (s *Server) handleSite(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, site{ICP: s.cfg.ICPBeian, Police: s.cfg.PoliceBeian, PoliceCode: digits(s.cfg.PoliceBeian)})
}

// digits 取出字符串里的数字。
func digits(v string) string {
	var b strings.Builder
	for _, r := range v {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
