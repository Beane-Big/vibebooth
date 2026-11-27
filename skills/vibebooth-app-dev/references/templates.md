# Vibebooth 应用最小模板参考

## 1. 0 级：纯前端应用（Vite + React / Vue / 原生 HTML）

### `module.yaml`
```yaml
platform: 1
id: hello-app
name: 示例工具
description: 一个轻量纯前端工具
version: 0.1.0
icon: icon.svg
services:
  frontend:
    port: 80
```

### `compose.yaml`
```yaml
services:
  hello-app-frontend:
    image: vb-hello-app-frontend:${VERSION}
    build: ./frontend
    restart: unless-stopped
```

### `frontend/nginx.conf`
```nginx
server {
  listen 80;
  root /usr/share/nginx/html;

  location = /apps/hello-app {
    return 301 /apps/hello-app/;
  }

  location /apps/hello-app/ {
    alias /usr/share/nginx/html/;
    try_files $uri $uri/ /apps/hello-app/index.html;
    add_header Cache-Control "no-cache";
  }

  location /apps/hello-app/assets/ {
    alias /usr/share/nginx/html/assets/;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }
}
```

### `frontend/Dockerfile`
```dockerfile
FROM node:22-alpine AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
COPY package*.json ./
RUN npm config set registry ${NPM_REGISTRY} && npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

### `frontend/vite.config.ts`
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/apps/hello-app/",
  plugins: [react()],
});
```

---

## 2. 1–4 级：全栈应用（前端 + Go 后端 + SQLite）

### `module.yaml`
```yaml
platform: 1
id: feedback
name: 意见箱
description: 收集用户反馈并推送提醒给管理员
version: 0.1.0
icon: icon.svg
services:
  frontend:
    port: 80
  backend:
    port: 8000
menus:
  - { id: home, name: 首页, path: /apps/feedback/, default: [user] }
  - { id: manage, name: 管理, path: /apps/feedback/manage/, requires: manage }
permissions:
  - { id: manage, name: 管理反馈, description: 查看并回复所有反馈, default: [admin] }
```

### `compose.yaml`
```yaml
services:
  feedback-frontend:
    image: vb-feedback-frontend:${VERSION}
    build: ./frontend
    depends_on: [feedback-backend]
    restart: unless-stopped
  feedback-backend:
    image: vb-feedback-backend:${VERSION}
    build: ./backend
    environment:
      DATA_DIR: /data
    volumes:
      - data:/data
    restart: unless-stopped

volumes:
  data:
```

### `backend/Dockerfile`（Go）
```dockerfile
FROM golang:1.26-alpine AS build
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go mod tidy && CGO_ENABLED=0 go build -mod=mod -trimpath -ldflags="-s -w" -o /out/server .

FROM alpine:3.22
RUN adduser -D -u 10001 app && mkdir /data && chown app /data
USER app
COPY --from=build /out/server /usr/local/bin/server
EXPOSE 8000
ENTRYPOINT ["server"]
```

### `frontend/src/platform.ts`（统一接口请求与未登录自动跳转）
```ts
const API_BASE = "/api/feedback";
let redirecting = false;

function redirectToLogin() {
  if (redirecting) return;
  redirecting = true;
  // 必须使用当前窗口跳 /login?next=...，由平台统一询问用户是否登录或注册；
  // 严禁调用 location.reload()，否则公开可见模式下会死循环刷新。
  location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("需要登录");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `请求失败 (${res.status})`);
  return body as T;
}
```

### `backend/Dockerfile`（Node.js 备选）
```dockerfile
FROM node:22-alpine
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
COPY package*.json ./
RUN npm config set registry ${NPM_REGISTRY} && npm ci --omit=dev
COPY . .
EXPOSE 8000
CMD ["node", "server.js"]
```

### `backend/Dockerfile`（Python FastAPI 备选）
```dockerfile
FROM python:3.12-slim
ARG PIP_INDEX_URL=https://pypi.org/simple
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -i ${PIP_INDEX_URL} -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## 3. 后端调用平台消息推送示例（Go）

```go
func notifyAdmins(ctx context.Context, title, body, link string) {
	payload, _ := json.Marshal(map[string]any{
		"target": map[string]any{"role": "admin"},
		"appId":  "feedback",
		"title":  title,
		"body":   body,
		"link":   link,
		"urgent": true,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"http://core:8080/api/platform/ext/v1/notifications", bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}
```

---

## 4. 可换色图标模板 `icon.svg`

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#4f6ef7"/>
  <path d="M20 24h24v16H30l-8 6v-6h-2V24z" fill="#ffffff"/>
</svg>
```
