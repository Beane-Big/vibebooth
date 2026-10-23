package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var (
	// Docker 接口的路径可以带版本前缀，例如 /v1.47/build。
	versionPrefix = regexp.MustCompile(`^/v[0-9.]+(/.*)$`)
	// 模块镜像名：vb-<模块 id>-<服务>，可以带标签。不能带仓库地址或斜杠，否则就不是本机的模块镜像了。
	moduleImage = regexp.MustCompile(`^vb-[a-z][a-z0-9-]*(:[A-Za-z0-9_.-]{1,128})?$`)
	imagePath   = regexp.MustCompile(`^/images/([^/]+)(/json|/get|/tag)?$`)
)

// buildParams 是 POST /build 允许带的参数。不在其中的一律拒绝，例如 outputs（能把结果导出成任意名字的镜像）、
// networkmode（能用宿主机网络）、remote（让 Docker 自己去拉取任意地址的构建上下文）。
var buildParams = map[string]bool{
	"t": true, "dockerfile": true, "buildargs": true, "labels": true, "target": true, "platform": true,
	"pull": true, "nocache": true, "rm": true, "forcerm": true, "q": true, "version": true,
}

// allow 判断一个 Docker 接口请求能不能放行，不能时返回原因。
func allow(r *http.Request) error {
	path := r.URL.Path
	if m := versionPrefix.FindStringSubmatch(path); m != nil {
		path = m[1]
	}
	q := r.URL.Query()
	switch {
	case (r.Method == http.MethodGet || r.Method == http.MethodHead) && path == "/_ping",
		r.Method == http.MethodGet && (path == "/version" || path == "/info"),
		r.Method == http.MethodGet && path == "/images/json",
		r.Method == http.MethodPost && path == "/build/prune":
		return nil
	case r.Method == http.MethodPost && path == "/build":
		return allowBuild(q)
	case r.Method == http.MethodGet && path == "/images/get":
		names := q["names"]
		if len(names) == 0 {
			return errors.New("导出镜像时要写明镜像名")
		}
		return checkImages(names)
	}
	if m := imagePath.FindStringSubmatch(path); m != nil {
		name, err := url.PathUnescape(m[1])
		if err != nil {
			return err
		}
		switch {
		case r.Method == http.MethodGet && (m[2] == "/json" || m[2] == "/get"),
			r.Method == http.MethodDelete && m[2] == "":
			return checkImages([]string{name})
		case r.Method == http.MethodPost && m[2] == "/tag":
			// 构建器构建前给同名的旧镜像打一个备份名，构建完再把名字还给它；新旧名字都必须是模块镜像。
			if q.Get("repo") == "" {
				return errors.New("打标签时要写明 repo")
			}
			tag := q.Get("repo")
			if q.Get("tag") != "" {
				tag += ":" + q.Get("tag")
			}
			return checkImages([]string{name, tag})
		}
	}
	return fmt.Errorf("不允许 %s %s", r.Method, path)
}

func allowBuild(q url.Values) error {
	for key := range q {
		if !buildParams[key] {
			return fmt.Errorf("构建不允许使用参数 %s", key)
		}
	}
	tags := q["t"]
	if len(tags) == 0 {
		return errors.New("构建时要用 t 参数给镜像起名，而且必须是 vb- 开头的模块镜像")
	}
	return checkImages(tags)
}

func checkImages(names []string) error {
	for _, name := range names {
		if !moduleImage.MatchString(strings.TrimPrefix(name, "docker.io/library/")) {
			return fmt.Errorf("%s 不是模块镜像，只能操作 vb- 开头的镜像", name)
		}
	}
	return nil
}
