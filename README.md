# Vibebooth

一个给 vibe coding 作品用的自托管平台，在自己的电脑或服务器上运行：公开应用可以直接体验，登录后使用联系人和个人权限等功能。设计说明见[架构设计文档](https://claude.ai/code/artifact/41500730-289a-40bb-9a1a-9f922d44d355)。部署步骤见 [DEPLOY.md](DEPLOY.md)（自己的电脑）和 [DEPLOY-SERVER.md](DEPLOY-SERVER.md)（国内云服务器），架构原理见 [ARCHITECTURE.md](ARCHITECTURE.md)。

平台本体包括网关、登录、门户、模块安装器和按人的菜单与功能权限；模块在各自的仓库里开发、打包，在门户“应用管理”页上传安装，不用重启平台。新模块用脚手架 [create-vibebooth](https://github.com/Beane-Big/create-vibebooth) 生成，门户主题用 [create-vibebooth-theme](https://github.com/Beane-Big/create-vibebooth-theme) 生成。

## 组成

| 目录 | 内容 |
| --- | --- |
| `docker-compose.yml` | 平台本体：网关 Traefik、两个 Docker 代理、PostgreSQL、平台核心、门户、模块安装器 |
| `core/` | 平台核心（Go）：登录与会话、给网关做登录和菜单权限校验、签发模块令牌、人员与账号管理（一一对应）、应用注册表 |
| `portal/` | 门户前端（React + Vite）：登录页、应用列表和标签栏，以及自带的“用户”“设置”两个应用（“应用管理”在“设置”里） |
| `installer/` | 模块安装器（Go）：校验模块包、启动和卸载模块；也是模块打包用的命令行工具 |
| `build-proxy/` | 构建代理（Go）：给声明了 `docker-build` 特权的模块用的 Docker 门卫，只放行 `vb-` 开头的模块镜像的构建和查看、打标签、导出、删除 |
| `packages/manifest/` | 模块清单 `module.yaml` 的解析和校验，平台核心和安装器共用 |
| `packages/modpkg/` | 模块包（软件包）的校验、生成和 compose 文件转换，安装器和构建器共用 |
| `packages/sdk-go/` | 模块后端用的 Go SDK，目前提供令牌校验、菜单和功能权限判断 |
| `scripts/module` | 在命令行安装、卸载、列出模块 |
| `docs/module-spec.md` | 模块开发规范 |
| `docs/theme-spec.md` | 门户主题规范 |
| `.github/workflows/installer-image.yml` | 在 main 上打标签 `installer/vX.Y.Z` 时，把安装器镜像发布到 `ghcr.io/beane-big/vibebooth-installer`，模块在没有平台的机器上打包时用它 |

请求路径约定：

- `/` 门户
- `/api/platform/` 平台核心接口
- `/api/platform/installer/` 模块安装器接口，要有平台的“应用管理”权限（管理员总有）
- `/apps/<模块id>/` 模块前端，`/api/<模块id>/` 模块后端；都要先登录，并且至少有这个模块的一个菜单，菜单页面还要有对应菜单
- `/api/<模块id>/ext/v1/` 模块的对外接口，`/api/platform/ext/v1/` 平台的对外接口（人员），都只给模块后端在内部网络里调用，网关不转发
- `/contacts`、`/settings` 门户自带的“联系人”“设置”应用。“联系人”里账号和人员一一对应（有账号就有人员），账号、权限只有管理员能管；其他人看到的是自己添加的联系人，可以写只有自己看得到的备注。旧网址 `/admin/users` 打开“联系人”；“设置”里的“应用管理”要有“应用管理”权限；旧网址 `/admin/modules` 打开“设置”

## 第一次启动

运行 Vibebooth **不需要预先安装 Node.js、Go 或数据库**，只需 Docker。即使电脑上还没装 Docker，下面的一键脚本也会**自动检测并安装/启动 Docker**，同时自动下载代码、生成 `.env` 和随机强密码、探测国内网络并配置加速源，优先拉取预构建镜像（暂不可用时自动切换本机源码构建）。

### Windows（PowerShell）

在开始菜单打开 **PowerShell**，粘贴运行：

```powershell
irm https://raw.githubusercontent.com/Beane-Big/vibebooth/main/scripts/install.ps1 | iex
```

- 未安装 Docker 时会自动通过 `winget` 或官方安装程序安装并拉起 Docker Desktop；如首次安装系统提示需要重启电脑，重启后再次运行上述命令即可。
- 也可以在 WSL Ubuntu 中使用下方的 Linux 命令部署（详见 [DEPLOY.md](DEPLOY.md)）。

### macOS / Linux / 云服务器 / NAS / WSL Ubuntu

打开 **终端（Terminal）**，粘贴运行：

```bash
curl -fsSL https://raw.githubusercontent.com/Beane-Big/vibebooth/main/scripts/install.sh | bash
```

- **Linux / WSL**：未装 Docker 时自动安装 Docker Engine 及 Compose 插件，国内网络自动配置 Docker / Go / npm 加速源。
- **macOS**：已安装 Homebrew 时自动安装并拉起 Docker Desktop；未安装 Homebrew 时会提示安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 或 [OrbStack](https://orbstack.dev/)，装好后再运行一次即可。

### 已下载代码到本地 / 手动启动

如果你已经通过 `git clone` 下载了仓库，在项目目录中直接运行对应脚本即可：

```bash
# macOS / Linux / WSL（支持 --from-source、--cn、--port=8080）
bash scripts/install.sh
```

```powershell
# Windows PowerShell（支持 -FromSource、-Cn、-Port 8080）
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

也可以手动配置后直接用 `docker compose` 启动：

```bash
cp .env.example .env
# 编辑 .env：设置 POSTGRES_PASSWORD 和 ADMIN_PASSWORD（至少 8 位）
docker compose up -d --build
```

启动完成后，终端会打印本机访问地址（默认 <http://localhost:8080>）、局域网访问地址以及首次生成的管理员账号密码。打开浏览器登录后，可按首页新手指引修改密码，并在「设置」里自定义站点名称、图标、消息推送与数据备份。

常用命令：

```bash
docker compose ps                   # 查看各服务状态
docker compose logs -f core         # 查看平台核心日志
docker compose up -d --build        # 改了平台本体的代码后重新构建并启动，不影响模块
docker compose down                 # 停止平台本体（数据保留在卷里）；模块容器不受影响
scripts/module list                 # 查看已安装的模块
scripts/module install x.zip        # 在命令行安装模块包，和在门户上传一样
bash scripts/backup.sh export       # 一键备份数据库、平台数据及全部模块数据卷
bash scripts/backup.sh restore x.tar.gz # 从备份文件恢复
```

## 在局域网里访问

1. 在路由器里给这台电脑固定一个局域网 IP。
2. 在 Windows 防火墙里为 8080 端口添加入站规则，只允许“专用”网络。
3. 其他人的手机、iPad、电脑连同一个 Wi-Fi，打开 `http://<电脑的局域网IP>:8080`。

路由器上不要为 8080 做端口转发，平台目前不应暴露到公网。

## 开发一个新模块

推荐使用 **Vibe Coding 开发规范 Skill**（`skills/vibebooth-app-dev/`，也可在门户「应用管理 → 应用构建」点击「下载开发 Skill」）：

1. 把 `vibebooth-app-dev` Skill 交给你的 AI 编码工具，直接描述你想做的应用。
2. 开发完成后运行 `node skills/vibebooth-app-dev/scripts/check-and-pack.mjs <应用目录>` 自动按平台规范自检并打包出 `<id>-<version>-source.zip`（无需本机 Docker）。
3. 在门户「应用管理 → 应用构建」上传源码包，一键构建并安装；若构建失败可直接点击「一键配置国内源」或「复制给 AI 修复」。

如需使用命令行脚手架本地打包（需要 Node.js 20+ 和 Docker，规范见 [docs/module-spec.md](docs/module-spec.md)）：

```bash
npx github:Beane-Big/create-vibebooth notes   # 生成 vibebooth-module-notes/，可选前端（React、Vue、静态页）和后端（Go）
cd vibebooth-module-notes
npm run install:local   # 本地构建、打包并装到本机平台，改了代码再运行一次
npm run pack            # 生成 dist/notes-0.1.0.zip，上传到正式平台的“应用管理”页
```

卸载在门户“应用管理”页操作，或者在平台仓库里运行 `scripts/module uninstall notes`（数据卷保留；加 `--purge` 连数据一起删）。

## 开发门户前端

```bash
cd portal
npm install
npm run dev   # 接口请求会转发到 localhost:8080，需要先用 docker compose 启动平台
```

## 账号注册和登录

登录页默认提供[账号注册](DEPLOY.md#账号注册)（管理员可在「设置 → 站点」中随时开启或关闭）。注册时邮箱选填，登录使用账号和密码。无需配置邮件服务。

平台自带管理员构建服务。在首页「应用管理 → 应用构建」上传源码 ZIP，构建成功后安装；也支持直接上传已构建安装包。首次部署无需额外安装构建器。部署网络、Go/npm 镜像源配置与平台共用。演进规划见 [docs/roadmap.md](docs/roadmap.md)。

构建器页面随 Portal 发布，构建 API 由 builder 服务提供。从独立构建页面升级时，同时重新构建并部署这两个服务（`docker compose up -d --build portal builder`）。
