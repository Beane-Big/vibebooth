package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ---- 用户管理（只有管理员能用，门户“用户”页调用）----

var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{2,32}$`)

type userInput struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
	Admin       bool   `json:"admin"`
	Disabled    bool   `json:"disabled"`
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
	return n >= 1 && n <= 32
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
	if in.DisplayName == "" {
		in.DisplayName = in.Username
	}
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
	var in userInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	switch {
	case !validDisplayName(in.DisplayName):
		writeError(w, http.StatusBadRequest, "显示名称不能为空，也不能超过 32 个字")
	// 不能停用自己或取消自己的管理员，避免平台里一个管理员都没有。
	case target.ID == me.ID && (in.Disabled || !in.Admin):
		writeError(w, http.StatusBadRequest, "不能停用自己，也不能取消自己的管理员")
	default:
		if err := s.store.UpdateUser(r.Context(), target.ID, in.DisplayName, in.Admin, in.Disabled); err != nil {
			internalError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *Server) handleSetPassword(w http.ResponseWriter, r *http.Request, _ *User) {
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
	if err := s.store.SetPassword(r.Context(), target.ID, in.Password); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- 按人授权菜单 ----

type menuGrantView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
	// Default 是按清单里的默认角色这个人有没有这个菜单；Override 是单独设置，nil 表示跟随默认。
	Default  bool  `json:"default"`
	Override *bool `json:"override"`
	Allowed  bool  `json:"allowed"`
}

type moduleGrantView struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Menus []menuGrantView `json:"menus"`
}

// handleUserMenus 列出所有已安装模块的菜单，以及这个人对每个菜单的默认值、单独设置和最终结果。
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
	for _, m := range s.registry.List() {
		if len(m.Menus) == 0 {
			continue
		}
		allowed := map[string]bool{}
		for _, menu := range menusFor(target, m, g) {
			allowed[menu.ID] = true
		}
		view := moduleGrantView{ID: m.ID, Name: m.Name}
		for _, menu := range m.Menus {
			v := menuGrantView{ID: menu.ID, Name: menu.Name, Path: menu.Path,
				Default: target.IsAdmin() || hasAnyRole(target.Roles, menu.Default), Allowed: allowed[menu.ID]}
			if o, ok := g[m.ID][menu.ID]; ok {
				v.Override = &o
			}
			view.Menus = append(view.Menus, v)
		}
		modules = append(modules, view)
	}
	writeJSON(w, http.StatusOK, map[string]any{"admin": target.IsAdmin(), "modules": modules})
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
	if !ok || m.MenuByID(in.Menu) == nil {
		writeError(w, http.StatusBadRequest, "模块或菜单不存在")
		return
	}
	if err := s.store.SetGrant(r.Context(), target.ID, in.Module, in.Menu, in.Allowed); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
