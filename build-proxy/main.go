// 构建代理：给声明了 docker-build 特权的模块（例如构建器）用的 Docker 接口门卫。
//
// 通用的 docker-socket-proxy 只能按接口整类开关，管不到镜像名字：能构建镜像，就能构建一个冒名的 traefik
// 或 docker-socket-proxy 镜像，等平台重启时拿到整台服务器。所以这里自己检查每个请求：
// 只放行构建镜像，查看、打标签、导出和删除 vb- 开头的模块镜像，清理构建缓存，其余一律拒绝。
package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"time"
)

func main() {
	socket := env("DOCKER_SOCKET", "/var/run/docker.sock")
	upstream := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL.Scheme = "http"
			r.Out.URL.Host = "docker"
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socket)
			},
		},
		// 构建日志是流式返回的，要边收边转，不能等整个响应结束。
		FlushInterval: -1,
	}
	srv := &http.Server{
		Addr:              ":2375",
		Handler:           guard(upstream),
		ReadHeaderTimeout: 10 * time.Second,
	}
	slog.Info("构建代理已启动", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("服务退出", "err", err)
		os.Exit(1)
	}
}

// guard 拒绝 allow 不放行的请求，并记下被拒绝的请求，方便排查模块为什么构建失败。
func guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := allow(r); err != nil {
			slog.Warn("拒绝请求", "method", r.Method, "path", r.URL.Path, "reason", err)
			http.Error(w, "构建代理拒绝了这个请求："+err.Error(), http.StatusForbidden)
			return
		}
		// Docker 构建时还没收完构建目录就开始返回进度。Go 的服务器默认在开始写响应后就不再读请求体，
		// 分块上传的构建目录会被截断（Docker 报 invalid tar header），所以要允许边收边发。
		http.NewResponseController(w).EnableFullDuplex()
		next.ServeHTTP(w, r)
	})
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
