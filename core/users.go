package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ---- 用户管理（只有管理员能用，门户“用户”应用调用）----

var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{2,32}$`)

type userInput struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
	// AdminPassword 只在重置密码时用：操作的管理员要再输入一次自己的密码。
	AdminPassword string `json:"adminPassword"`
	Admin         bool   `json:"admin"`
	Disabled      bool   `json:"disabled"`
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return false
	}
	return true
}

func validDisplayName(name string) bool {
	n := utf8.RuneCountInString(name)
	return n <= 32
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request, _ *User) {
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request, _ *User) {
	var in userInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Username, in.DisplayName = strings.TrimSpace(in.Username), strings.TrimSpace(in.DisplayName)
	switch {
	case !usernamePattern.MatchString(in.Username):
		writeError(w, http.StatusBadRequest, "用户名只能是 2 到 32 位字母、数字、下划线、点或连字符")
	case !validDisplayName(in.DisplayName):
		writeError(w, http.StatusBadRequest, "显示名称不能超过 32 个字")
	case len(in.Password) < 8:
		writeError(w, http.StatusBadRequest, "密码至少 8 位")
	default:
		u, err := s.store.CreateUser(r.Context(), in.Username, in.DisplayName, in.Password, in.Admin)
		if errors.Is(err, errUsernameTaken) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		if errors.Is(err, errPersonNotFound) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err != nil {
			internalError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, u)
	}
}

// targetUser 取路径里的用户；不存在时已经写好 404。
func (s *Server) targetUser(w http.ResponseWriter, r *http.Request) *User {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "用户不存在")
		return nil
	}
	u, err := s.store.UserByID(r.Context(), id)
	if err != nil {
		internalError(w, err)
		return nil
	}
	if u == nil {
		writeError(w, http.StatusNotFound, "用户不存在")
	}
	return u
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request, me *User) {
	target := s.targetUser(w, r)
	if target == nil {
		return
	}
	// 管理接口只接收权限和状态，拒绝夹带姓名、账号、头像等资料字段。
	var in struct {
		Admin    bool `json:"admin"`
		Disabled bool `json:"disabled"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "只能修改账号权限和状态，资料只能由本人修改")
		return
	}
	switch {
	// 不能停用自己或取消自己的管理员，避免平台里一个管理员都没有。
	case target.ID == me.ID && (in.Disabled || !in.Admin):
		writeError(w, http.StatusBadRequest, "不能停用自己，也不能取消自己的管理员")
	default:
		if err := s.store.UpdateUser(r.Context(), target.ID, in.Admin, in.Disabled); err != nil {
			internalError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleSetUserRemark 只更新原管理员备注，不允许通过备注接口改动身份资料。
func (s *Server) handleSetUserRemark(w http.ResponseWriter, r *http.Request, _ *User) {
	target := s.targetUser(w, r)
	if target == nil {
		return
	}
	var in struct {
		Remark string `json:"remark"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Remark = strings.TrimSpace(in.Remark)
	if utf8.RuneCountInString(in.Remark) > 200 {
		writeError(w, http.StatusBadRequest, "备注不能超过 200 个字")
		return
	}
	tag, err := s.store.pool.Exec(r.Context(), `UPDATE persons SET note=$1, updated_at=now() WHERE id=$2`, in.Remark, target.PersonID)
	if err != nil {
		internalError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "账号不存在")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSetPassword 重置别人的密码，要管理员再输入一次自己的密码，防止离开时被人用已登录的页面改掉密码。
// 输错和登录失败一样计入限流，不能用这里猜管理员密码。
func (s *Server) handleSetPassword(w http.ResponseWriter, r *http.Request, me *User) {
	target := s.targetUser(w, r)
	if target == nil {
		return
	}
	var in userInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if len(in.Password) < 8 {
		writeError(w, http.StatusBadRequest, "密码至少 8 位")
		return
	}
	ip := clientIP(r)
	if !s.limiter.Allow(ip) {
		writeError(w, http.StatusTooManyRequests, "密码输错次数过多，请稍后再试")
		return
	}
	ok, err := s.store.CheckPassword(r.Context(), me.Username, in.AdminPassword)
	if err != nil {
		internalError(w, err)
		return
	}
	if ok == nil {
		s.limiter.Fail(ip)
		writeError(w, http.StatusForbidden, "管理员密码不对")
		return
	}
	if err := s.store.SetPassword(r.Context(), target.ID, in.Password, nil); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSetMyPassword 改自己的密码，要先输入当前密码。输错和登录失败一样计入限流。
// 改完后其他设备要重新登录，当前这个会话保留。
func (s *Server) handleSetMyPassword(w http.ResponseWriter, r *http.Request, me *User) {
	var in struct {
		CurrentPassword string `json:"currentPassword"`
		Password        string `json:"password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	switch {
	case len(in.Password) < 8:
		writeError(w, http.StatusBadRequest, "密码至少 8 位")
		return
	case in.Password == in.CurrentPassword:
		writeError(w, http.StatusBadRequest, "新密码不能和当前密码一样")
		return
	}
	ip := clientIP(r)
	if !s.limiter.Allow(ip) {
		writeError(w, http.StatusTooManyRequests, "密码输错次数过多，请稍后再试")
		return
	}
	ok, err := s.store.CheckPassword(r.Context(), me.Username, in.CurrentPassword)
	if err != nil {
		internalError(w, err)
		return
	}
	if ok == nil {
		s.limiter.Fail(ip)
		writeError(w, http.StatusForbidden, "当前密码不对")
		return
	}
	hash, _ := sessionHash(r)
	if err := s.store.SetPassword(r.Context(), me.ID, in.Password, hash); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- 按人授权菜单和功能权限 ----

// grantView 是一个菜单或一项功能权限对某个人的授权状态。
type grantView struct {
	OptIn       bool   `json:"optIn,omitempty"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Default 是按清单里的默认角色这个人有没有；Override 是单独设置，nil 表示跟随默认。
	Default  bool  `json:"default"`
	Override *bool `json:"override"`
	Allowed  bool  `json:"allowed"`
}

// moduleGrantView 是一个应用对某个人的授权：Access 是能不能用整个应用，关掉后 Perms 和 Menus 都不生效。
// Menus 里只有能单独设置的菜单：写了 requires 的菜单跟着功能权限走，不在这里列出。
type moduleGrantView struct {
	ID     string      `json:"id"`
	Name   string      `json:"name"`
	Icon   string      `json:"icon,omitempty"`
	Access grantView   `json:"access"`
	Perms  []grantView `json:"perms"`
	Menus  []grantView `json:"menus"`
}

// handleUserMenus 列出平台和所有已安装应用，以及这个人对每个应用、每项功能权限和每个菜单的默认值、单独设置和最终结果。
// 平台排在第一组。功能权限和菜单显示的是应用打开时的结果，应用关掉时门户把它们收起来。
func (s *Server) handleUserMenus(w http.ResponseWriter, r *http.Request, _ *User) {
	target := s.targetUser(w, r)
	if target == nil {
		return
	}
	g, err := s.store.Grants(r.Context(), target.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	modules := []moduleGrantView{}
	for _, m := range append([]*Module{platformModule}, s.registry.List()...) {
		if m != platformModule && len(m.Menus) == 0 {
			continue // 只有后端的模块不在门户里出现，也就没有可设置的
		}
		view := moduleGrantView{ID: m.ID, Name: m.Name, Perms: []grantView{}, Menus: []grantView{}}
		if m.Icon != "" {
			view.Icon = "/api/platform/apps/" + m.ID + "/icon"
		}
		menus := grantedMenus(target, m, g)
		view.Access = grantView{ID: m.ID, Name: m.Name, Allowed: appAllowed(target, m, g),
			Default: target.IsAdmin() || m == platformModule || publicPageDefault(m, g) || len(menus) > 0}
		if o, ok := g.Apps[m.ID]; ok {
			view.Access.Override = &o
		}
		perms := grantedPerms(target, m, g)
		for _, p := range m.Permissions {
			grant := grantFor(target, p.ID, p.Name, p.Description, p.Default, g.Perms[m.ID], slices.Contains(perms, p.ID))
			grant.OptIn = p.OptIn
			if p.OptIn {
				grant.Default = false
			}
			view.Perms = append(view.Perms, grant)
		}
		allowed := menuIDs(menus)
		for _, menu := range m.Menus {
			if menu.Requires == "" {
				grant := grantFor(target, menu.ID, menu.Name, "", menu.Default,
					g.Menus[m.ID], slices.Contains(allowed, menu.ID))
				// 默认值与实际授权使用同一公开范围，恢复默认时也能正确回到开启状态。
				if publicPageDefault(m, g) {
					grant.Default = true
				}
				view.Menus = append(view.Menus, grant)
			}
		}
		modules = append(modules, view)
	}
	writeJSON(w, http.StatusOK, map[string]any{"admin": target.IsAdmin(), "modules": modules})
}

func grantFor(user *User, id, name, description string, roles []string, overrides map[string]bool, allowed bool) grantView {
	v := grantView{ID: id, Name: name, Description: description,
		Default: user.IsAdmin() || hasAnyRole(user.Roles, roles), Allowed: allowed}
	if o, ok := overrides[id]; ok {
		v.Override = &o
	}
	return v
}

// moduleByID 按 id 找已安装的模块，platform 是平台自己。
func (s *Server) moduleByID(id string) (*Module, bool) {
	if id == platformModule.ID {
		return platformModule, true
	}
	return s.registry.Get(id)
}

// handleSetUserApp 单独允许或禁止一个人使用整个应用，module 为 platform 时是门户本身。
func (s *Server) handleSetUserApp(w http.ResponseWriter, r *http.Request, _ *User) {
	target := s.targetUser(w, r)
	if target == nil {
		return
	}
	var in struct {
		Module  string `json:"module"`
		Allowed *bool  `json:"allowed"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := s.moduleByID(in.Module); !ok {
		writeError(w, http.StatusBadRequest, "应用不存在")
		return
	}
	if err := s.store.SetAppGrant(r.Context(), target.ID, in.Module, in.Allowed); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSetUserMenu(w http.ResponseWriter, r *http.Request, _ *User) {
	target := s.targetUser(w, r)
	if target == nil {
		return
	}
	var in struct {
		Module  string `json:"module"`
		Menu    string `json:"menu"`
		Allowed *bool  `json:"allowed"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	m, ok := s.registry.Get(in.Module)
	if !ok || m.MenuByID(in.Menu) == nil || m.MenuByID(in.Menu).Requires != "" {
		writeError(w, http.StatusBadRequest, "模块或菜单不存在，或者这个菜单跟着功能权限走")
		return
	}
	if err := s.store.SetGrant(r.Context(), target.ID, in.Module, in.Menu, in.Allowed); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSetUserPerm 单独设置一项功能权限，module 为 platform 时是平台自己的权限。
func (s *Server) handleSetUserPerm(w http.ResponseWriter, r *http.Request, _ *User) {
	target := s.targetUser(w, r)
	if target == nil {
		return
	}
	var in struct {
		Module  string `json:"module"`
		Perm    string `json:"perm"`
		Allowed *bool  `json:"allowed"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	m, ok := s.moduleByID(in.Module)
	if !ok || m.PermissionByID(in.Perm) == nil {
		writeError(w, http.StatusBadRequest, "模块或功能权限不存在")
		return
	}
	if err := s.store.SetPermGrant(r.Context(), target.ID, in.Module, in.Perm, in.Allowed); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
