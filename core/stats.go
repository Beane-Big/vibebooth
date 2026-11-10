package main

import (
	"context"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 活跃度统计：默认关闭，管理员在“统计”应用里打开。数据只存在本平台的数据库里，只有管理员能看。
// 门户在页面可见、最近 5 分钟有人操作时，每分钟报一次正在看哪个标签（心跳），一次心跳算一分钟；
// 切到一个标签时报一次“打开”。登录成功和失败由登录接口记录。明细保留 statsRetention，按天的汇总长期保留。
const (
	statsEnabledKey = "stats_enabled"
	statsRetention  = 90 * 24 * time.Hour
)

// 心跳里的应用：portal 是首页，portal:<id> 是平台自带的应用（见门户的 builtin.tsx），其他是模块 id。
var builtinStatsApp = regexp.MustCompile(`^portal(:[a-z][a-z0-9-]{0,30})?$`)

func (s *Server) statsEnabled(ctx context.Context) (bool, error) {
	v, err := s.store.Setting(ctx, statsEnabledKey)
	return v == "true", err
}

// handleStatsBeat 记一次心跳。统计关着时什么也不记，照样返回成功，门户不用知道开关。
func (s *Server) handleStatsBeat(w http.ResponseWriter, r *http.Request, user *User) {
	var req struct {
		App  string `json:"app"`
		Open bool   `json:"open"`
		// 设备有触摸屏。iPad 的 Safari 默认报和 Mac 一样的 User-Agent，要靠它区分。
		Touch bool `json:"touch"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !builtinStatsApp.MatchString(req.App) {
		if _, ok := s.registry.Get(req.App); !ok {
			writeError(w, http.StatusBadRequest, "应用不存在")
			return
		}
	}
	enabled, err := s.statsEnabled(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	if enabled {
		device := deviceType(r.UserAgent(), req.Touch)
		if err := s.store.RecordBeat(r.Context(), user.ID, req.App, device, req.Open, s.cfg.StatsTimezone); err != nil {
			internalError(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// recordLogin 在统计打开时记一次登录结果。记录失败不影响登录。
func (s *Server) recordLogin(ctx context.Context, username string, ok bool) {
	enabled, err := s.statsEnabled(ctx)
	if err == nil && enabled {
		err = s.store.RecordLogin(ctx, username, ok)
	}
	if err != nil {
		slog.Warn("记录登录失败", "err", err)
	}
}

// handleStats 返回最近 days 天（7、30 或 90，默认 30）的统计。
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request, _ *User) {
	days := 30
	if v := r.URL.Query().Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || (n != 7 && n != 30 && n != 90) {
			writeError(w, http.StatusBadRequest, "days 只能是 7、30 或 90")
			return
		}
		days = n
	}
	enabled, err := s.statsEnabled(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	report, err := s.store.StatsReport(r.Context(), days, s.cfg.StatsTimezone)
	if err != nil {
		internalError(w, err)
		return
	}
	report.Enabled = enabled
	// 模块的名称从注册表取；已经卸载的模块没有名称，门户显示 id。自带应用的名称由门户自己填。
	for i := range report.Apps {
		if m, ok := s.registry.Get(report.Apps[i].App); ok {
			report.Apps[i].Name = m.Name
		}
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleSetStats(w http.ResponseWriter, r *http.Request, _ *User) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	value := ""
	if req.Enabled {
		value = "true"
	}
	if err := s.store.SetSetting(r.Context(), statsEnabledKey, value); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleClearStats 删除全部统计数据（明细和按天的汇总），不改开关。
func (s *Server) handleClearStats(w http.ResponseWriter, r *http.Request, _ *User) {
	if err := s.store.ClearStats(r.Context()); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) cleanupStats(ctx context.Context) {
	for {
		if err := s.store.DeleteOldStats(ctx, time.Now().Add(-statsRetention)); err != nil {
			slog.Warn("清理过期统计失败", "err", err)
		}
		time.Sleep(time.Hour)
	}
}

// deviceType 按 User-Agent 粗分成 phone、tablet、desktop，只存这三种，不存完整的 User-Agent。
func deviceType(ua string, touch bool) string {
	switch {
	case strings.Contains(ua, "iPad"), strings.Contains(ua, "Tablet"),
		strings.Contains(ua, "Android") && !strings.Contains(ua, "Mobile"),
		strings.Contains(ua, "Macintosh") && touch:
		return "tablet"
	case strings.Contains(ua, "Mobi"), strings.Contains(ua, "iPhone"), strings.Contains(ua, "Android"):
		return "phone"
	default:
		return "desktop"
	}
}
