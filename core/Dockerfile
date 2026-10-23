# 构建上下文是仓库根目录（见 docker-compose.yml），以便引用 packages/manifest。
FROM golang:1.26-alpine AS build
# 国内服务器上可以在 .env 里设置 GOPROXY 换成国内的 Go 代理，不设置时用官方代理。
ARG GOPROXY=https://proxy.golang.org,direct
WORKDIR /src
COPY packages/manifest ./packages/manifest
COPY core ./core
WORKDIR /src/core
RUN go mod download && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/core .

FROM alpine:3.22
RUN adduser -D -u 10001 app && mkdir /data && chown app /data
USER app
COPY --from=build /out/core /usr/local/bin/core
EXPOSE 8080
ENTRYPOINT ["core"]
