package main

import (
	_ "embed"
	"html/template"
	"log/slog"
	"net/http"
)

// deniedReason 是打不开模块页面的原因，决定提示页上的话。
type deniedReason int

const (
	deniedApp     deniedReason = iota // 应用开关关着
	deniedNoPages                     // 应用开着，但里面一个页面都没给他
	deniedPage                        // 有别的页面，只是没有这一个
)

//go:embed denied.html
var deniedHTML string

var deniedTemplate = template.Must(template.New("denied").Parse(deniedHTML))

// writeDenied 在网关拦下页面时返回一个提示页，说明为什么打不开、该找谁。网关把它原样交给浏览器，
// 在门户的标签页里和单独打开时都能看到。接口被拦时不用它，仍然返回 JSON。
func writeDenied(w http.ResponseWriter, app *Module, reason deniedReason) {
	data := struct {
		App, Title, Detail string
	}{App: app.Name}
	switch reason {
	case deniedApp:
		data.Title = "无权访问"
		data.Detail = "你没有「" + app.Name + "」的使用权限，请联系管理员。"
	case deniedNoPages:
		data.Title = "暂无可访问的页面"
		data.Detail = "请联系管理员开通「" + app.Name + "」的页面权限。"
	default:
		data.Title = "无权访问此页面"
		data.Detail = "请联系管理员开通权限。"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusForbidden)
	if err := deniedTemplate.Execute(w, data); err != nil {
		slog.Warn("输出无权限提示页失败", "err", err)
	}
}
