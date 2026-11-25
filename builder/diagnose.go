package main

import (
	"slices"
	"strings"
)

// BuildDiagnosis 是对失败构建日志的结构化诊断，供前端展示一键修复按钮（配置国内源、清理缓存）和生成给 AI 的排错上下文。
type BuildDiagnosis struct {
	Category      string     `json:"category,omitempty"`
	Summary       string     `json:"summary"`
	SuggestedArgs []BuildArg `json:"suggestedArgs,omitempty"`
	CanPruneCache bool       `json:"canPruneCache,omitempty"`
}

func diagnoseBuild(log string, settings Settings) *BuildDiagnosis {
	if strings.TrimSpace(log) == "" {
		return nil
	}
	lower := strings.ToLower(log)
	var suggested []BuildArg
	addArg := func(name, value string) {
		if settings.Arg(name) != "" {
			return
		}
		for _, a := range suggested {
			if a.Name == name {
				return
			}
		}
		suggested = append(suggested, BuildArg{Name: name, Value: value})
	}

	var goProxy, npm, pip, dockerHub, network bool
	var unset []string
	for line := range strings.Lines(log) {
		if name, ok := strings.CutPrefix(strings.TrimSpace(line), "构建参数 "); ok {
			if name, ok := strings.CutSuffix(name, unsetArg); ok && !slices.Contains(unset, name) {
				unset = append(unset, name)
			}
		}
		if !containsAny(line, networkErrors) {
			continue
		}
		network = true
		goProxy = goProxy || strings.Contains(line, "proxy.golang.org")
		npm = npm || strings.Contains(line, "registry.npmjs.org")
		pip = pip || strings.Contains(line, "pypi.org") || strings.Contains(line, "files.pythonhosted.org")
		dockerHub = dockerHub || strings.Contains(line, "docker.io")
	}

	if strings.Contains(lower, "no space left on device") {
		return &BuildDiagnosis{
			Category:      "disk",
			Summary:       "服务器磁盘空间不足，可先清理构建缓存后重试。",
			CanPruneCache: true,
		}
	}
	if strings.Contains(lower, "exit code: 137") || strings.Contains(lower, "javascript heap out of memory") || strings.Contains(lower, "cannot allocate memory") {
		return &BuildDiagnosis{
			Category: "oom",
			Summary:  "构建过程内存不足（OOM），建议检查依赖体量或为服务器增加 Swap 空间。",
		}
	}

	var hints []string
	if goProxy {
		addArg("GOPROXY", "https://goproxy.cn,direct")
		if v := settings.Arg("GOPROXY"); v == "" {
			hints = append(hints, "连不上官方 Go 代理 proxy.golang.org，建议配置 GOPROXY = https://goproxy.cn,direct。")
		} else {
			hints = append(hints, "已配置 GOPROXY = "+v+"，但仍在访问 proxy.golang.org，请检查 Dockerfile 是否声明了 ARG GOPROXY。")
		}
	}
	if npm {
		addArg("NPM_REGISTRY", "https://registry.npmmirror.com")
		if v := settings.Arg("NPM_REGISTRY"); v == "" {
			hints = append(hints, "连不上官方 npm 源 registry.npmjs.org，建议配置 NPM_REGISTRY = https://registry.npmmirror.com。")
		} else {
			hints = append(hints, "已配置 NPM_REGISTRY = "+v+"，但仍在访问 registry.npmjs.org，请检查 Dockerfile 是否声明了 ARG NPM_REGISTRY。")
		}
	}
	if pip {
		addArg("PIP_INDEX_URL", "https://pypi.tuna.tsinghua.edu.cn/simple")
		if v := settings.Arg("PIP_INDEX_URL"); v == "" {
			hints = append(hints, "连不上官方 PyPI 源，建议配置 PIP_INDEX_URL = https://pypi.tuna.tsinghua.edu.cn/simple。")
		} else {
			hints = append(hints, "已配置 PIP_INDEX_URL = "+v+"，请检查 Dockerfile 是否声明了 ARG PIP_INDEX_URL。")
		}
	}
	if network && !dockerHub {
		var others []string
		for _, name := range unset {
			if name != "GOPROXY" && name != "NPM_REGISTRY" && name != "PIP_INDEX_URL" {
				others = append(others, name)
			}
		}
		if len(others) > 0 {
			hints = append(hints, "Dockerfile 还声明了未配置的构建参数："+strings.Join(others, "、")+"，可在构建器设置中补充镜像源。")
		}
	}
	if dockerHub {
		hints = append(hints, "服务器无法拉取 Docker Hub 基础镜像，请为宿主机 Docker 配置镜像加速。")
	}

	if len(hints) > 0 {
		return &BuildDiagnosis{
			Category:      "mirror",
			Summary:       strings.Join(hints, "\n"),
			SuggestedArgs: suggested,
		}
	}
	return nil
}
