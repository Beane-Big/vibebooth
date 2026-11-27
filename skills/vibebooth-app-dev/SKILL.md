---
name: vibebooth-app-dev
description: 开发、自检并打包符合 Vibebooth 平台规范（platform: 1）的应用源码包。当用户要为 Vibebooth 开发新应用、修改现有应用、或将应用打包上传到 Vibebooth 内置构建器时使用。
---

# Vibebooth 应用开发规范 Skill

本 Skill 让 AI 编码工具直接从零开发符合 Vibebooth `platform: 1` 规范的应用，无需脚手架或本机 Docker，开发完成后运行内置脚本自检并打包为 `source.zip`，上传到 Vibebooth 的「应用管理 → 应用构建」即可一键构建并安装。

## 一、开发前确认

1. 确定应用 **id**（小写字母开头，仅含小写字母、数字和连字符，2–31 位，安装后不可更改；禁止使用 `platform`、`core`、`portal`、`traefik`、`postgres`、`socket`、`installer`、`build`、`builder`）。
2. 确定与平台的**耦合等级**（按需选择，不越级）：
   - **0 级（纯前端）**：只有前端容器，数据存在浏览器或无需存储。
   - **1 级（加后端）**：增加后端容器与数据卷（默认 SQLite），后端校验网关注入的 JWT。
   - **2 级（认人）**：按令牌 `sub` 隔离每人数据。
   - **3 级（分权）**：在 `module.yaml` 声明 `menus` 与 `permissions`，后端按功能权限校验。
   - **4 级（用平台能力）**：调用平台内部接口读取联系人、解析头像与称呼、或发送消息通知。

## 二、目录结构要求

```text
<app-dir>/
├── module.yaml         # 必需：应用清单
├── compose.yaml        # 必需：容器定义（仅含白名单字段）
├── icon.svg            # 必需：单份矢量图标（根目录）
├── frontend/           # 有前端服务时必需
│   ├── Dockerfile
│   ├── nginx.conf
│   └── ...
└── backend/            # 有后端服务时必需
    ├── Dockerfile
    └── ...
```

具体最小可用模板见 [references/templates.md](references/templates.md)。

## 三、平台硬性规范（构建器与安装器会严格校验）

### 1. `module.yaml`
- 必需字段：`platform: 1`、`id`、`name`、`version`（`x.y.z`，每次升级必须调大）、`icon`（如 `icon.svg`）、`services`。
- `services` 只允许声明对外的 `frontend`（挂载到 `/apps/<id>/`）和 `backend`（挂载到 `/api/<id>/`），各写明容器内 `port`。
- `menus` 的 `path` 必须在 `/apps/<id>/` 下；若页面跟随某项功能权限开关，写 `requires: <perm-id>`。
- 需要给未登录用户开放分享页或游客投稿页时，在 `privileges` 声明 `public-share`（固定放行 `/apps/<id>/s/` 与 `/api/<id>/s/`，其余路径仍强制登录）。

### 2. `compose.yaml`
- 顶层只允许 `services` 和 `volumes`。
- 服务名必须是 `<id>-<小写字母或数字>`（对外服务固定为 `<id>-frontend` 和 `<id>-backend`）。
- 每个服务**必须**包含：
  - `image: vb-<id>-<suffix>:${VERSION}`
  - `build: ./frontend` 或 `build: { context: ./backend, dockerfile: Dockerfile }`（必须是仓库内相对路径，不能用 `..` 跳出仓库）
- **允许的服务字段**：`image`、`build`、`environment`、`command`、`volumes`、`depends_on`、`healthcheck`、`restart`、`user`。
- **严禁出现**：`ports`、`networks`、`labels`、`privileged`、`network_mode`、挂载宿主机路径（`./data:/data` 之类）；除 `image` 中的 `${VERSION}` 外，**整份文件不能出现 `$`**，所有 `environment` 必须写明值。
- 网关路由、网络 `platform`、`JWKS_URL` 和日志轮转均由安装器自动补齐，不要手写。

### 3. 前端约定
- 构建 base 路径固定为 `/apps/<id>/`（Vite 设 `base: "/apps/<id>/"`），调用后端接口使用相对路径 `/api/<id>/...`。
- Nginx 对 `index.html` 必须返回 `Cache-Control: no-cache`（带哈希的静态资源可长期缓存），防止升级后浏览器停留在旧版本。
- 应用运行在门户的 iframe 标签页中（也支持新标签页直接打开）：**禁止设置** `X-Frame-Options` 或阻止同源嵌入的 CSP `frame-ancestors`。
- **未登录自动跳转平台登录引导（必看）**：管理员可将应用设为「公开可见」，让未登录用户在门户看到平台有哪些能力；此时网关放行 `/apps/<id>/` 前端页面（返回 `200`），但所有 `/api/<id>/*` 接口仍返回 `401`。
  - **应用自己不做登录按钮、登录页或访客登录引导**，登录/注册询问完全交由平台统一处理。
  - **统一请求层收到 `401` 时，必须立即用当前窗口跳转**：`location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search)`（加防重标志，避免并发请求重复跳转）。独立页签会直接进入平台「此功能需要登录，是否前往登录/注册？」提示页，登录后自动带原路径与参数跳回；门户 iframe 内会被门户自动拦截并弹出同样的登录确认框。
  - **严禁**在收到 `401` 时调用 `location.reload()` 或 `window.top.location.reload()`，否则在公开模式下会陷入 `200 页面 → 401 接口 → reload` 无限刷新死循环，且会破坏门户 iframe 的登录拦截。
- **实时与有状态应用**：使用 SSE 实时同步时须设置 `X-Accel-Buffering: no` 与定时心跳，前端做好页面刷新状态恢复（URL / 本地存储）、切后台唤醒同步、断线自动重连（SSE 异常且在线时探测普通接口以感知 `401` 会话失效）。
- 页面自适应手机、平板与桌面；按应用题材打造有辨识度的视觉与交互（避免千篇一律的通用暗黑毛玻璃模板），保持界面文案简洁克制，不堆砌多余说明。

### 4. 后端约定
- **健康检查**：必须提供 `GET /api/<id>/health`，正常返回 2xx，**不要求登录令牌**。
- **统一鉴权**：不写登录代码。网关会将已签发的 RS256 JWT 放入 `Authorization: Bearer <token>`（`iss: home-platform`，`aud: <id>`），公钥地址通过环境变量 `JWKS_URL`（默认 `http://core:8080/api/platform/.well-known/jwks.json`）获取。
  - Go 后端优先使用官方 SDK：`github.com/Beane-Big/vibebooth/packages/sdk-go/auth`（`v0.2.0+` 需 Go `1.26+`，Dockerfile 使用 `golang:1.26-alpine`）。
  - Node.js / Python 后端使用标准 JWKS 库校验 RS256、`iss` 和 `aud`，读取 `sub`（账号 ID）、`name`、`menus`、`perms`。
- **独立运行模式**：支持环境变量 `STANDALONE=1` 脱离平台本地调试，但**严禁**在 `compose.yaml` 中配置 `STANDALONE=1`。
- **数据存储**：持久化数据只放在 `compose.yaml` 声明的命名卷中（默认 SQLite），升级表结构需兼容旧数据；有进行中状态的互动/游戏应用应将活跃状态持久化，避免容器重启丢进度。
- **Dockerfile 镜像源支持**：为保证国内服务器顺利构建，按语言声明对应 `ARG`（构建器会自动按名称注入平台镜像源）：
  - Go：`ARG GOPROXY=https://proxy.golang.org,direct` + `ENV GOPROXY=${GOPROXY}`
  - Node/前端：`ARG NPM_REGISTRY=https://registry.npmjs.org/` + `npm config set registry ${NPM_REGISTRY}`
  - Python：`ARG PIP_INDEX_URL=https://pypi.org/simple` + `pip install -i ${PIP_INDEX_URL} ...`

### 5. 图标 `icon.svg`
- 放在项目根目录，不另在前端重复存放图标。
- 禁止使用 `<text>`、`<image>`、`<style>`、`<script>`（文字需先转路径）。
- 推荐结构：首个元素为铺满画布的底色 `<rect>`，其余图形使用单一白色，以支持门户主题自动换色。

## 四、平台公共能力接口（后端内部网络直连 `http://core:8080`）

以下接口仅供模块后端在内部网络调用，网关不会转发给浏览器：

1. **读取当前用户的联系人**：
   - `GET http://core:8080/api/platform/ext/v1/users/{id}/contacts?mutual=1`
   - 传 `mutual=1` 只返回互为好友的联系人。
2. **批量解析账号资料与备注名**：
   - `GET http://core:8080/api/platform/ext/v1/users?ids=1,2,3&viewer={sub}`
   - 返回的 `displayName` 按 `备注 > 姓名 > 账号` 自动解析。
3. **向用户或管理员发送消息通知（站内实时推送 + 离线外部通道）**：
   - `POST http://core:8080/api/platform/ext/v1/notifications`
   - 请求体（JSON）：
     ```json
     {
       "target": { "userIds": [2], "role": "admin" },
       "appId": "<你的模块id>",
       "title": "通知标题",
       "body": "通知正文",
       "link": "/apps/<你的模块id>/...",
       "dedupKey": "可选防重键",
       "urgent": true
     }
     ```
   - `target.userIds` 与 `target.role`（目前支持 `"admin"`）至少填一项；`link` 须为本站相对路径；`urgent: true` 允许在用户离线时触发其配置的 Bark/企业微信/飞书/钉钉/Webhook 提醒。

## 五、自检与打包（交付前必做）

写完代码后，在应用根目录运行内置自检打包脚本（需要 Node.js 20+，无需安装任何依赖，也无需 Docker）：

```bash
node <skill目录>/scripts/check-and-pack.mjs .
```

脚本会逐项检查 `module.yaml`、`compose.yaml`、`icon.svg` 和 `Dockerfile`，通过后自动排除 `node_modules`、`.git`、`dist` 等无用目录，在当前目录生成 `<id>-<version>-source.zip`。

最后引导用户在 Vibebooth 门户打开「应用管理 → 应用构建」，拖入生成的 `.zip` 文件，按需勾选「构建并安装」与权限范围后点击「开始构建」。
