# 构建上下文是仓库根目录（见 docker-compose.yml），以便引用 packages/manifest、packages/modpkg 和 packages/sdk-go。
FROM golang:1.26-alpine AS build
# 国内服务器上可以在 .env 里设置 GOPROXY 换成国内的 Go 代理，不设置时用官方代理。
ARG GOPROXY=https://proxy.golang.org,direct
WORKDIR /src
COPY packages/manifest ./packages/manifest
COPY packages/modpkg ./packages/modpkg
COPY packages/sdk-go ./packages/sdk-go
COPY installer ./installer
WORKDIR /src/installer
RUN go mod download && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/installer .

# 运行时要用 docker 命令行和 compose 插件来导入镜像、启动模块，官方 docker:cli 镜像自带这两样。
# 以 root 运行：它通过 TCP 访问 socket-proxy，root 不会多出 Docker 权限；模块卷第一次创建时也不用操心属主。
FROM docker:29-cli
COPY --from=build /out/installer /usr/local/bin/installer
EXPOSE 8000
ENTRYPOINT ["installer"]
