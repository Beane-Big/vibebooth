package main

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:webdist
var frontendFiles embed.FS

func builderFrontend() http.Handler {
	files, err := fs.Sub(frontendFiles, "webdist")
	if err != nil {
		panic(err)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/apps/builder/")
		name = strings.TrimPrefix(path.Clean("/"+name), "/")
		if name == "." || name == "" {
			name = "index.html"
		}
		data, err := fs.ReadFile(files, name)
		if err != nil && (name == "settings" || name == "settings/") {
			name = "index.html"
			data, err = fs.ReadFile(files, name)
		}
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "private, max-age=2592000, immutable")
		} else {
			w.Header().Set("Cache-Control", "private, no-cache")
		}
		switch path.Ext(name) {
		case ".html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		case ".js":
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		case ".css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		case ".svg":
			w.Header().Set("Content-Type", "image/svg+xml")
		}
		w.Write(data)
	})
}
