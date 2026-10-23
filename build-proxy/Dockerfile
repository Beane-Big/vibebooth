FROM golang:1.26-alpine AS build
# 国内服务器上可以在 .env 里设置 GOPROXY 换成国内的 Go 代理，不设置时用官方代理。
ARG GOPROXY=https://proxy.golang.org,direct
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/build-proxy .

# 以 root 运行：要连宿主机的 docker.sock。它只监听内部网络 platform-build，只有声明了构建特权的模块后端连得上。
FROM alpine:3.22
COPY --from=build /out/build-proxy /usr/local/bin/build-proxy
EXPOSE 2375
ENTRYPOINT ["build-proxy"]
