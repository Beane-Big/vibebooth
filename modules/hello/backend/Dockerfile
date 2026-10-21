# 构建上下文是仓库根目录（见 modules/hello/compose.yaml），以便引用 packages/sdk-go。
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY packages/sdk-go ./packages/sdk-go
COPY modules/hello/backend ./modules/hello/backend
WORKDIR /src/modules/hello/backend
RUN go mod download && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/hello .

FROM alpine:3.22
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/hello /usr/local/bin/hello
EXPOSE 8000
ENTRYPOINT ["hello"]
