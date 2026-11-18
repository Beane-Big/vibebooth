FROM node:22-alpine AS frontend
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app/frontend
COPY builder/frontend/package.json builder/frontend/package-lock.json ./
RUN npm ci --registry="$NPM_REGISTRY" --no-audit --no-fund
COPY builder/icon.svg /app/icon.svg
COPY builder/frontend/ ./
RUN npm run build

FROM golang:1.26-alpine AS build
ARG GOPROXY=https://proxy.golang.org,direct
WORKDIR /src
COPY packages/manifest ./packages/manifest
COPY packages/modpkg ./packages/modpkg
COPY packages/sdk-go ./packages/sdk-go
COPY builder ./builder
COPY --from=frontend /app/frontend/dist ./builder/webdist
WORKDIR /src/builder
RUN go mod download && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/builder .

FROM alpine:3.22
RUN adduser -D -u 10001 app && mkdir /data && chown app /data
USER app
COPY --from=build /out/builder /usr/local/bin/builder
EXPOSE 8000
ENTRYPOINT ["builder"]
