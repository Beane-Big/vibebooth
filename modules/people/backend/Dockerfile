# 构建上下文是仓库根目录（见 modules/people/compose.yaml），以便引用 packages/sdk-go。
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY packages/sdk-go ./packages/sdk-go
COPY modules/people/backend ./modules/people/backend
WORKDIR /src/modules/people/backend
RUN go mod download && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/people .

FROM alpine:3.22
RUN adduser -D -u 10001 app
# 数据目录挂载命名卷；先建好并交给 app 用户，卷第一次创建时会沿用这个属主。
RUN mkdir /data && chown app /data
USER app
COPY --from=build /out/people /usr/local/bin/people
EXPOSE 8000
ENTRYPOINT ["people"]
