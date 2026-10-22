package main

import (
	"net/http"
	"slices"

	"github.com/Beane-Big/home-platform/packages/manifest"
)

// menusFor 返回一个人在某个模块里能用的菜单：有单独设置的按设置，没有的按清单里的默认角色。
// 管理员拥有全部菜单，避免把自己锁在设置页外面。一个菜单都没有，就看不到也打不开这个模块。
func menusFor(user *User, m *Module, g grants) []manifest.Menu {
	var menus []manifest.Menu
	for _, menu := range m.Menus {
		allowed, set := g[m.ID][menu.ID]
		if user.IsAdmin() || (set && allowed) || (!set && hasAnyRole(user.Roles, menu.Default)) {
			menus = append(menus, menu)
		}
	}
	return menus
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
