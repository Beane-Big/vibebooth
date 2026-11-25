FROM golang:1.26-alpine AS build
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /src
COPY packages/manifest ./packages/manifest
COPY packages/modpkg ./packages/modpkg
COPY packages/sdk-go ./packages/sdk-go
COPY builder ./builder
WORKDIR /src/builder
RUN go mod download && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/builder .

FROM alpine:3.22
RUN adduser -D -u 10001 app && mkdir /data && chown app /data
USER app
COPY --from=build /out/builder /usr/local/bin/builder
COPY skills /usr/local/share/vibebooth/skills
EXPOSE 8000
ENTRYPOINT ["builder"]
