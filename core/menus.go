package main

import (
	"net/http"
	"slices"

	"github.com/Beane-Big/vibebooth/packages/manifest"
)

// platformModule 是平台自己的权限表，格式和模块清单一样，id 用保留名 platform，模块不会和它重名。
// 授权同样存在 perm_grants 里，“用户”应用把它和各模块并排显示。
// “用户”应用不在这里：能管账号的人可以给自己勾上任何权限，等于管理员，所以仍然只给管理员。
var platformModule = &Module{Manifest: &manifest.Manifest{
	ID:   "platform",
	Name: "平台",
	Permissions: []manifest.Permission{
		{ID: permSettings, Name: "设置", Description: "打开“设置”应用", Default: []string{"user"}},
		{ID: permModules, Name: "应用管理", Description: "在“设置”里安装、升级和卸载应用，要同时有“设置”", Default: []string{"admin"}},
	},
}}

const (
	permSettings = "settings"
	permModules  = "modules"
)

// permsFor 返回一个人在某个模块里有的功能权限：有单独设置的按设置，没有的按清单里的默认角色。管理员拥有全部权限。
func permsFor(user *User, m *Module, g grants) []string {
	var perms []string
	for _, p := range m.Permissions {
		allowed, set := g.Perms[m.ID][p.ID]
		if user.IsAdmin() || (set && allowed) || (!set && hasAnyRole(user.Roles, p.Default)) {
			perms = append(perms, p.ID)
		}
	}
	return perms
}

// menusFor 返回一个人在某个模块里能用的菜单。管理员拥有全部菜单，避免把自己锁在设置页外面。
// 一个菜单都没有，就看不到也打不开这个模块。
func menusFor(user *User, m *Module, g grants) []manifest.Menu {
	perms := permsFor(user, m, g)
	var menus []manifest.Menu
	for _, menu := range m.Menus {
		if user.IsAdmin() || menuAllowed(user, m.ID, menu, g, perms) {
			menus = append(menus, menu)
		}
	}
	return menus
}

// menuAllowed：写了 requires 的菜单跟着那项功能权限走；其他的有单独设置按设置，没有的按清单里的默认角色。
func menuAllowed(user *User, module string, menu manifest.Menu, g grants, perms []string) bool {
	if menu.Requires != "" {
		return slices.Contains(perms, menu.Requires)
	}
	allowed, set := g.Menus[module][menu.ID]
	return (set && allowed) || (!set && hasAnyRole(user.Roles, menu.Default))
}

func menuIDs(menus []manifest.Menu) []string {
	ids := make([]string, len(menus))
	for i, m := range menus {
		ids[i] = m.ID
	}
	return ids
}

// canOpenPage 判断能否打开前端的某个网址。模块首页（菜单 path 等于 /apps/<id>/）下还放着静态资源，
// 所以只要有这个模块的任一菜单就能访问；其他菜单的页面要有对应菜单才行。
func canOpenPage(m *Module, menus []manifest.Menu, path string) bool {
	menu := m.MenuFor(path)
	if menu == nil || menu.Path == m.FrontendPath() {
		return len(menus) > 0
	}
	return slices.ContainsFunc(menus, func(x manifest.Menu) bool { return x.ID == menu.ID })
}

// hasPlatformPerm 判断一个人有没有平台自己的某项权限。
func (s *Server) hasPlatformPerm(r *http.Request, user *User, perm string) (bool, error) {
	g, err := s.store.Grants(r.Context(), user.ID)
	if err != nil {
		return false, err
	}
	return slices.Contains(permsFor(user, platformModule, g), perm), nil
}

// handleAppMenus 给模块前端用：返回当前用户在这个模块里的菜单，模块据此渲染导航。
func (s *Server) handleAppMenus(w http.ResponseWriter, r *http.Request, user *User) {
	m, ok := s.registry.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "应用不存在")
		return
	}
	g, err := s.store.Grants(r.Context(), user.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	menus := menusFor(user, m, g)
	if menus == nil {
		menus = []manifest.Menu{}
	}
	writeJSON(w, http.StatusOK, menus)
}
