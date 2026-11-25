package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	notifReadRetention   = 30 * 24 * time.Hour
	notifUnreadRetention = 90 * 24 * time.Hour
	notifDedupWindow     = 5 * time.Minute
	maxNotifChannels     = 20
	maxNotifTargets      = 200
)

type notification struct {
	ID        int64      `json:"id"`
	AppID     string     `json:"appId"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	Link      string     `json:"link"`
	ReadAt    *time.Time `json:"readAt"`
	CreatedAt time.Time  `json:"createdAt"`
}

type notificationChannel struct {
	ID        int64     `json:"id"`
	Scope     string    `json:"scope"` // "user" 或 "system"
	Kind      string    `json:"kind"`  // webhook | bark | wecom | feishu | dingtalk
	Name      string    `json:"name"`
	TargetURL string    `json:"targetUrl"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"createdAt"`
}

type pushTarget struct {
	UserIDs []int64 `json:"userIds"`
	Role    string  `json:"role"`
}

type pushInput struct {
	Target   pushTarget `json:"target"`
	AppID    string     `json:"appId"`
	Title    string     `json:"title"`
	Body     string     `json:"body"`
	Link     string     `json:"link"`
	DedupKey string     `json:"dedupKey"`
	Urgent   bool       `json:"urgent"`
}

type sseEvent struct {
	Name string
	Data any
}

// notifHub 管理所有登录用户的 SSE 长连接，用于实时推送新通知和未读数，
// 同时据此判断用户当前是否在线（在线时走站内实时提醒，离线时再触发外部推送通道）。
type notifHub struct {
	mu   sync.RWMutex
	subs map[int64]map[chan sseEvent]struct{}
}

func newNotifHub() *notifHub {
	return &notifHub{subs: map[int64]map[chan sseEvent]struct{}{}}
}

func (h *notifHub) Subscribe(userID int64) (chan sseEvent, func()) {
	ch := make(chan sseEvent, 16)
	h.mu.Lock()
	if h.subs[userID] == nil {
		h.subs[userID] = map[chan sseEvent]struct{}{}
	}
	h.subs[userID][ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		if m := h.subs[userID]; m != nil {
			delete(m, ch)
			if len(m) == 0 {
				delete(h.subs, userID)
			}
		}
		h.mu.Unlock()
	}
}

func (h *notifHub) Online(userID int64) bool {
	if h == nil {
		return false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs[userID]) > 0
}

func (h *notifHub) Publish(userID int64, ev sseEvent) {
	if h == nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.subs[userID] {
		select {
		case ch <- ev:
		default:
			// 客户端消费过慢时丢弃这条实时事件，不影响数据库中的站内记录。
		}
	}
}

func (s *Server) mountNotifications(mux *http.ServeMux) {
	extLimiter := newLoginLimiter(120, time.Minute)
	mux.HandleFunc("GET /api/platform/notifications", s.requireUser(s.handleListNotifications))
	mux.HandleFunc("GET /api/platform/notifications/stream", s.requireUser(s.handleNotificationStream))
	mux.HandleFunc("POST /api/platform/notifications/{id}/read", s.requireUser(s.handleMarkNotificationRead))
	mux.HandleFunc("POST /api/platform/notifications/read-all", s.requireUser(s.handleMarkAllNotificationsRead))
	mux.HandleFunc("DELETE /api/platform/notifications/{id}", s.requireUser(s.handleDeleteNotification))

	mux.HandleFunc("GET /api/platform/notification-channels", s.requireUser(s.handleListChannels))
	mux.HandleFunc("POST /api/platform/notification-channels", s.requireUser(s.handleCreateChannel))
	mux.HandleFunc("PUT /api/platform/notification-channels/{id}", s.requireUser(s.handleUpdateChannel))
	mux.HandleFunc("DELETE /api/platform/notification-channels/{id}", s.requireUser(s.handleDeleteChannel))
	mux.HandleFunc("POST /api/platform/notification-channels/{id}/test", s.requireUser(s.handleTestChannel))

	// 对外内部接口：给模块后端在内部网络调用（http://core:8080/api/platform/ext/v1/notifications），网关不转发。
	mux.HandleFunc("POST /api/platform/ext/v1/notifications", func(w http.ResponseWriter, r *http.Request) {
		var in pushInput
		if !decodeJSON(w, r, &in) {
			return
		}
		key := strings.TrimSpace(in.AppID)
		if key == "" {
			key = "unknown"
		}
		if !extLimiter.Allow(key) {
			writeError(w, http.StatusTooManyRequests, "推送过于频繁，请稍后再试")
			return
		}
		extLimiter.Fail(key)
		count, err := s.notify(r.Context(), in)
		if err != nil {
			var bad *badRequestError
			if errors.As(err, &bad) {
				writeError(w, http.StatusBadRequest, bad.msg)
				return
			}
			internalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]int{"delivered": count})
	})
}

type badRequestError struct{ msg string }

func (e *badRequestError) Error() string { return e.msg }

func (s *Server) handleListNotifications(w http.ResponseWriter, r *http.Request, me *User) {
	w.Header().Set("Cache-Control", "private, no-store")
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = min(n, 100)
		}
	}
	unreadOnly := r.URL.Query().Get("unread") == "1" || r.URL.Query().Get("unread") == "true"

	query := `SELECT id, app_id, title, body, link, read_at, created_at FROM notifications WHERE user_id = $1`
	if unreadOnly {
		query += ` AND read_at IS NULL`
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT $2`

	rows, err := s.store.pool.Query(r.Context(), query, me.ID, limit)
	if err != nil {
		internalError(w, err)
		return
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (notification, error) {
		var n notification
		err := row.Scan(&n.ID, &n.AppID, &n.Title, &n.Body, &n.Link, &n.ReadAt, &n.CreatedAt)
		return n, err
	})
	if err != nil {
		internalError(w, err)
		return
	}
	if items == nil {
		items = []notification{}
	}
	unread, err := s.unreadNotificationCount(r.Context(), me.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "unreadCount": unread})
}

func (s *Server) handleNotificationStream(w http.ResponseWriter, r *http.Request, me *User) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "不支持实时推送流")
		return
	}
	// 取消 http.Server 默认的 30 秒 WriteTimeout，避免 SSE 长连接被提前断开。
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	unread, err := s.unreadNotificationCount(r.Context(), me.ID)
	if err != nil {
		return
	}
	ch, unsub := s.hub.Subscribe(me.ID)
	defer unsub()

	writeSSE(w, flusher, sseEvent{Name: "init", Data: map[string]int{"unreadCount": unread}})

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		case ev := <-ch:
			writeSSE(w, flusher, ev)
		}
	}
}

func writeSSE(w http.ResponseWriter, flusher http.Flusher, ev sseEvent) {
	data, err := json.Marshal(ev.Data)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Name, data)
	flusher.Flush()
}

func (s *Server) handleMarkNotificationRead(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return
	}
	tag, err := s.store.pool.Exec(r.Context(),
		`UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2`,
		id, me.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		http.NotFound(w, r)
		return
	}
	if unread, err := s.unreadNotificationCount(r.Context(), me.ID); err == nil {
		s.hub.Publish(me.ID, sseEvent{Name: "unread", Data: map[string]int{"unreadCount": unread}})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMarkAllNotificationsRead(w http.ResponseWriter, r *http.Request, me *User) {
	if _, err := s.store.pool.Exec(r.Context(),
		`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, me.ID); err != nil {
		internalError(w, err)
		return
	}
	s.hub.Publish(me.ID, sseEvent{Name: "unread", Data: map[string]int{"unreadCount": 0}})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteNotification(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return
	}
	tag, err := s.store.pool.Exec(r.Context(), `DELETE FROM notifications WHERE id = $1 AND user_id = $2`, id, me.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		http.NotFound(w, r)
		return
	}
	if unread, err := s.unreadNotificationCount(r.Context(), me.ID); err == nil {
		s.hub.Publish(me.ID, sseEvent{Name: "unread", Data: map[string]int{"unreadCount": unread}})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) unreadNotificationCount(ctx context.Context, userID int64) (int, error) {
	var n int
	err := s.store.pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL`, userID).Scan(&n)
	return n, err
}

// notify 写入站内通知，实时推送给在线用户的 SSE 连接；用户离线且消息允许站外提醒时，异步发送到已启用的外部推送通道。
func (s *Server) notify(ctx context.Context, in pushInput) (int, error) {
	if s.store == nil {
		return 0, nil
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return 0, &badRequestError{msg: "通知标题不能为空"}
	}
	if utf8.RuneCountInString(title) > 120 {
		return 0, &badRequestError{msg: "通知标题不能超过 120 个字符"}
	}
	body := strings.TrimSpace(in.Body)
	if utf8.RuneCountInString(body) > 1000 {
		return 0, &badRequestError{msg: "通知正文不能超过 1000 个字符"}
	}
	appID := strings.TrimSpace(in.AppID)
	if appID == "" {
		appID = "platform"
	}
	if len(appID) > 40 {
		return 0, &badRequestError{msg: "appId 过长"}
	}
	link := sanitizeNotificationLink(in.Link)
	dedupKey := strings.TrimSpace(in.DedupKey)
	if len(dedupKey) > 120 {
		dedupKey = dedupKey[:120]
	}

	userIDs, err := s.resolveNotifyTargets(ctx, in.Target)
	if err != nil {
		return 0, err
	}
	if len(userIDs) == 0 {
		return 0, nil
	}

	delivered := 0
	var offlineAdminTargeted bool
	for _, uid := range userIDs {
		n, err := s.insertOrMergeNotification(ctx, uid, appID, title, body, link, dedupKey)
		if err != nil {
			slog.Error("写入通知失败", "userId", uid, "appId", appID, "err", err)
			continue
		}
		delivered++
		unread, _ := s.unreadNotificationCount(ctx, uid)
		s.hub.Publish(uid, sseEvent{
			Name: "notification",
			Data: map[string]any{"notification": n, "unreadCount": unread},
		})
		if !s.hub.Online(uid) {
			if in.Target.Role == "admin" {
				offlineAdminTargeted = true
			}
			go s.dispatchUserChannels(uid, n, in.Urgent)
		}
	}
	if offlineAdminTargeted && in.Urgent {
		go s.dispatchSystemChannels(notification{AppID: appID, Title: title, Body: body, Link: link, CreatedAt: time.Now()})
	}
	return delivered, nil
}

func (s *Server) resolveNotifyTargets(ctx context.Context, target pushTarget) ([]int64, error) {
	seen := map[int64]bool{}
	var ids []int64
	if len(target.UserIDs) > 0 {
		list := target.UserIDs
		if len(list) > maxNotifTargets {
			list = list[:maxNotifTargets]
		}
		rows, err := s.store.pool.Query(ctx, `SELECT id FROM users WHERE id = ANY($1) AND NOT disabled`, list)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	if target.Role == "admin" {
		rows, err := s.store.pool.Query(ctx, `SELECT id FROM users WHERE 'admin' = ANY(roles) AND NOT disabled`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

func (s *Server) insertOrMergeNotification(ctx context.Context, userID int64, appID, title, body, link, dedupKey string) (notification, error) {
	var n notification
	if dedupKey != "" {
		err := s.store.pool.QueryRow(ctx, `
			UPDATE notifications
			SET title = $4, body = $5, link = $6, created_at = now()
			WHERE id = (
				SELECT id FROM notifications
				WHERE user_id = $1 AND app_id = $2 AND dedup_key = $3
				  AND read_at IS NULL AND created_at > now() - $7::interval
				ORDER BY id DESC LIMIT 1
			)
			RETURNING id, app_id, title, body, link, read_at, created_at`,
			userID, appID, dedupKey, title, body, link, fmt.Sprintf("%d seconds", int(notifDedupWindow.Seconds())),
		).Scan(&n.ID, &n.AppID, &n.Title, &n.Body, &n.Link, &n.ReadAt, &n.CreatedAt)
		if err == nil {
			return n, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return n, err
		}
	}
	err := s.store.pool.QueryRow(ctx, `
		INSERT INTO notifications (user_id, app_id, title, body, link, dedup_key)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, app_id, title, body, link, read_at, created_at`,
		userID, appID, title, body, link, dedupKey,
	).Scan(&n.ID, &n.AppID, &n.Title, &n.Body, &n.Link, &n.ReadAt, &n.CreatedAt)
	return n, err
}

// sanitizeNotificationLink 只允许本站相对路径，避免外部钓鱼链接注入通知抽屉。
func sanitizeNotificationLink(raw string) string {
	link := strings.TrimSpace(raw)
	if link == "" || len(link) > 512 {
		return ""
	}
	if !strings.HasPrefix(link, "/") || strings.HasPrefix(link, "//") || strings.ContainsAny(link, "\\\r\n ") {
		return ""
	}
	return link
}

// ---- 外部推送通道管理 ----

var validChannelKinds = map[string]bool{
	"webhook":  true,
	"bark":     true,
	"wecom":    true,
	"feishu":   true,
	"dingtalk": true,
}

func validateChannelURL(raw string) (string, error) {
	v := strings.TrimSpace(raw)
	if v == "" || len(v) > 512 {
		return "", errors.New("请输入有效的推送地址")
	}
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "", errors.New("推送地址必须以 http:// 或 https:// 开头")
	}
	// 拦截云厂商元数据地址，防止 SSRF 探测实例凭据。
	if ip := net.ParseIP(u.Hostname()); ip != nil && ip.IsLinkLocalUnicast() {
		return "", errors.New("不允许使用该地址")
	}
	return v, nil
}

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request, me *User) {
	w.Header().Set("Cache-Control", "private, no-store")
	var rows pgx.Rows
	var err error
	if me.IsAdmin() {
		rows, err = s.store.pool.Query(r.Context(), `
			SELECT id, CASE WHEN user_id IS NULL THEN 'system' ELSE 'user' END, kind, name, target_url, enabled, created_at
			FROM notification_channels
			WHERE user_id = $1 OR user_id IS NULL
			ORDER BY (user_id IS NULL) DESC, id`, me.ID)
	} else {
		rows, err = s.store.pool.Query(r.Context(), `
			SELECT id, 'user', kind, name, target_url, enabled, created_at
			FROM notification_channels
			WHERE user_id = $1
			ORDER BY id`, me.ID)
	}
	if err != nil {
		internalError(w, err)
		return
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (notificationChannel, error) {
		var c notificationChannel
		err := row.Scan(&c.ID, &c.Scope, &c.Kind, &c.Name, &c.TargetURL, &c.Enabled, &c.CreatedAt)
		return c, err
	})
	if err != nil {
		internalError(w, err)
		return
	}
	if items == nil {
		items = []notificationChannel{}
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request, me *User) {
	var in struct {
		Scope     string `json:"scope"`
		Kind      string `json:"kind"`
		Name      string `json:"name"`
		TargetURL string `json:"targetUrl"`
		Enabled   *bool  `json:"enabled"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	scope := in.Scope
	if scope == "" {
		scope = "user"
	}
	if scope != "user" && scope != "system" {
		writeError(w, http.StatusBadRequest, "无效的作用范围")
		return
	}
	if scope == "system" && !me.IsAdmin() {
		writeError(w, http.StatusForbidden, "只有管理员可以配置系统通知通道")
		return
	}
	if !validChannelKinds[in.Kind] {
		writeError(w, http.StatusBadRequest, "不支持的推送通道类型")
		return
	}
	targetURL, err := validateChannelURL(in.TargetURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := strings.TrimSpace(in.Name)
	if utf8.RuneCountInString(name) > 40 {
		writeError(w, http.StatusBadRequest, "名称不能超过 40 个字符")
		return
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}

	var owner *int64
	if scope == "user" {
		owner = &me.ID
		var count int
		if err := s.store.pool.QueryRow(r.Context(), `SELECT count(*) FROM notification_channels WHERE user_id = $1`, me.ID).Scan(&count); err != nil {
			internalError(w, err)
			return
		}
		if count >= maxNotifChannels {
			writeError(w, http.StatusBadRequest, "推送通道数量已达上限")
			return
		}
	}
	var c notificationChannel
	c.Scope = scope
	err = s.store.pool.QueryRow(r.Context(), `
		INSERT INTO notification_channels (user_id, kind, name, target_url, enabled)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, kind, name, target_url, enabled, created_at`,
		owner, in.Kind, name, targetURL, enabled,
	).Scan(&c.ID, &c.Kind, &c.Name, &c.TargetURL, &c.Enabled, &c.CreatedAt)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return
	}
	existing, ownerID, ok := s.loadOwnedChannel(w, r, id, me)
	if !ok {
		return
	}
	var in struct {
		Kind      *string `json:"kind"`
		Name      *string `json:"name"`
		TargetURL *string `json:"targetUrl"`
		Enabled   *bool   `json:"enabled"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Kind != nil {
		if !validChannelKinds[*in.Kind] {
			writeError(w, http.StatusBadRequest, "不支持的推送通道类型")
			return
		}
		existing.Kind = *in.Kind
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if utf8.RuneCountInString(name) > 40 {
			writeError(w, http.StatusBadRequest, "名称不能超过 40 个字符")
			return
		}
		existing.Name = name
	}
	if in.TargetURL != nil {
		u, err := validateChannelURL(*in.TargetURL)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		existing.TargetURL = u
	}
	if in.Enabled != nil {
		existing.Enabled = *in.Enabled
	}
	_, err = s.store.pool.Exec(r.Context(), `
		UPDATE notification_channels SET kind = $2, name = $3, target_url = $4, enabled = $5
		WHERE id = $1 AND (user_id IS NOT DISTINCT FROM $6)`,
		id, existing.Kind, existing.Name, existing.TargetURL, existing.Enabled, ownerID)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, existing)
}

func (s *Server) handleDeleteChannel(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return
	}
	_, ownerID, ok := s.loadOwnedChannel(w, r, id, me)
	if !ok {
		return
	}
	_, err = s.store.pool.Exec(r.Context(), `DELETE FROM notification_channels WHERE id = $1 AND (user_id IS NOT DISTINCT FROM $2)`, id, ownerID)
	if err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTestChannel(w http.ResponseWriter, r *http.Request, me *User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return
	}
	ch, _, ok := s.loadOwnedChannel(w, r, id, me)
	if !ok {
		return
	}
	siteInfo, _ := s.currentSite(r.Context())
	testNotif := notification{
		AppID:     "platform",
		Title:     siteInfo.Name + " 推送测试",
		Body:      "推送通道配置正常。",
		CreatedAt: time.Now(),
	}
	if err := sendChannelPush(r.Context(), ch, testNotif); err != nil {
		writeError(w, http.StatusBadGateway, "测试推送失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) loadOwnedChannel(w http.ResponseWriter, r *http.Request, id int64, me *User) (notificationChannel, *int64, bool) {
	var c notificationChannel
	var ownerID *int64
	err := s.store.pool.QueryRow(r.Context(), `
		SELECT id, user_id, kind, name, target_url, enabled, created_at
		FROM notification_channels WHERE id = $1`, id,
	).Scan(&c.ID, &ownerID, &c.Kind, &c.Name, &c.TargetURL, &c.Enabled, &c.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return c, nil, false
	}
	if err != nil {
		internalError(w, err)
		return c, nil, false
	}
	if ownerID == nil {
		if !me.IsAdmin() {
			http.NotFound(w, r)
			return c, nil, false
		}
		c.Scope = "system"
	} else {
		if *ownerID != me.ID {
			http.NotFound(w, r)
			return c, nil, false
		}
		c.Scope = "user"
	}
	return c, ownerID, true
}

func (s *Server) dispatchUserChannels(userID int64, n notification, urgent bool) {
	if !urgent {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	rows, err := s.store.pool.Query(ctx, `
		SELECT id, 'user', kind, name, target_url, enabled, created_at
		FROM notification_channels WHERE user_id = $1 AND enabled`, userID)
	if err != nil {
		return
	}
	channels, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (notificationChannel, error) {
		var c notificationChannel
		err := row.Scan(&c.ID, &c.Scope, &c.Kind, &c.Name, &c.TargetURL, &c.Enabled, &c.CreatedAt)
		return c, err
	})
	if err != nil {
		return
	}
	for _, ch := range channels {
		if err := sendChannelPush(ctx, ch, n); err != nil {
			slog.Warn("外部推送失败", "channelId", ch.ID, "kind", ch.Kind, "err", err)
		}
	}
}

func (s *Server) dispatchSystemChannels(n notification) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	rows, err := s.store.pool.Query(ctx, `
		SELECT id, 'system', kind, name, target_url, enabled, created_at
		FROM notification_channels WHERE user_id IS NULL AND enabled`)
	if err != nil {
		return
	}
	channels, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (notificationChannel, error) {
		var c notificationChannel
		err := row.Scan(&c.ID, &c.Scope, &c.Kind, &c.Name, &c.TargetURL, &c.Enabled, &c.CreatedAt)
		return c, err
	})
	if err != nil {
		return
	}
	for _, ch := range channels {
		if err := sendChannelPush(ctx, ch, n); err != nil {
			slog.Warn("系统外部推送失败", "channelId", ch.ID, "kind", ch.Kind, "err", err)
		}
	}
}

var pushHTTPClient = &http.Client{Timeout: 8 * time.Second}

func buildChannelPayload(kind string, n notification) map[string]any {
	text := n.Title
	if n.Body != "" {
		text += "\n" + n.Body
	}
	switch kind {
	case "bark":
		return map[string]any{
			"title": n.Title,
			"body":  n.Body,
			"group": n.AppID,
		}
	case "wecom":
		return map[string]any{
			"msgtype": "text",
			"text":    map[string]string{"content": text},
		}
	case "feishu":
		return map[string]any{
			"msg_type": "text",
			"content":  map[string]string{"text": text},
		}
	case "dingtalk":
		return map[string]any{
			"msgtype": "text",
			"text":    map[string]string{"content": text},
		}
	default:
		return map[string]any{
			"event":     "notification",
			"appId":     n.AppID,
			"title":     n.Title,
			"body":      n.Body,
			"link":      n.Link,
			"createdAt": n.CreatedAt.UTC().Format(time.RFC3339),
		}
	}
}

func sendChannelPush(ctx context.Context, ch notificationChannel, n notification) error {
	payload, err := json.Marshal(buildChannelPayload(ch.Kind, n))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ch.TargetURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := pushHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func (s *Server) cleanupNotifications(ctx context.Context) {
	prune := func() {
		_, err := s.store.pool.Exec(ctx, `
			DELETE FROM notifications
			WHERE (read_at IS NOT NULL AND read_at < now() - $1::interval)
			   OR (read_at IS NULL AND created_at < now() - $2::interval)`,
			fmt.Sprintf("%d seconds", int(notifReadRetention.Seconds())),
			fmt.Sprintf("%d seconds", int(notifUnreadRetention.Seconds())),
		)
		if err != nil {
			slog.Warn("清理过期通知失败", "err", err)
		}
	}
	prune()
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			prune()
		}
	}
}
