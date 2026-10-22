# Vibebooth

一个给 vibe coding 作品用的自托管平台，在自己的电脑上运行：登录一次门户，就能打开各个独立的应用模块。设计说明见[架构设计文档](https://claude.ai/code/artifact/41500730-289a-40bb-9a1a-9f922d44d355)。部署步骤见 [DEPLOY.md](DEPLOY.md)，架构原理见 [ARCHITECTURE.md](ARCHITECTURE.md)。

平台本体包括网关、登录、门户、模块安装器和按人的菜单权限；模块在各自的仓库里开发、打包，在门户“应用管理”页上传安装，不用重启平台。新模块用脚手架 [create-vibebooth](https://github.com/Beane-Big/create-vibebooth) 生成。现有模块：人员管理 [vibebooth-module-people](https://github.com/Beane-Big/vibebooth-module-people)、家庭优化大师 [vibebooth-module-family-score](https://github.com/Beane-Big/vibebooth-module-family-score)。

## 组成

| 目录 | 内容 |
| --- | --- |
| `docker-compose.yml` | 平台本体：网关 Traefik、两个 Docker 代理、PostgreSQL、平台核心、门户、模块安装器 |
| `core/` | 平台核心（Go）：登录与会话、给网关做登录和菜单权限校验、签发模块令牌、用户管理、应用注册表 |
| `portal/` | 门户前端（React + Vite）：登录页、应用列表、设置入口、应用管理、用户 |
| `installer/` | 模块安装器（Go）：校验模块包、启动和卸载模块；也是模块打包用的命令行工具 |
| `packages/manifest/` | 模块清单 `module.yaml` 的解析和校验，平台核心和安装器共用 |
| `packages/sdk-go/` | 模块后端用的 Go SDK，目前提供令牌校验和菜单权限判断 |
| `scripts/module` | 在命令行安装、卸载、列出模块 |
| `docs/module-spec.md` | 模块开发规范 |

请求路径约定：

- `/` 门户
- `/api/platform/` 平台核心接口
- `/api/platform/installer/` 模块安装器接口，只有管理员能调用
- `/apps/<模块id>/` 模块前端，`/api/<模块id>/` 模块后端；都要先登录，并且至少有这个模块的一个菜单，菜单页面还要有对应菜单
- `/api/<模块id>/ext/v1/` 模块的对外接口，只给其他模块后端在内部网络里调用，网关不转发
- `/settings` 门户的设置页，汇总模块清单里 `settings: true` 的菜单
- `/admin/modules`、`/admin/users` 门户的应用管理页和用户页，只对管理员显示

## 第一次启动

在 WSL 的 Ubuntu 里操作（代码放在 Linux 文件系统里，例如 `~/home-platform`，不要放在 `/mnt/c/` 下）。Docker Desktop 需要在运行，并在 Settings → Resources → WSL integration 里对 Ubuntu 打开集成。

```bash
git clone https://github.com/Beane-Big/vibebooth.git ~/home-platform
cd ~/home-platform
cp .env.example .env
# 编辑 .env：设置 POSTGRES_PASSWORD 和 ADMIN_PASSWORD（至少 8 位）
docker compose up -d --build
```

浏览器打开 <http://localhost:8080>，用 `.env` 里的管理员账号登录。这时还没有应用，在“应用管理”页上传模块包（zip）就能装上；模块包在各模块仓库里用 `npm run pack` 生成，`people` 要先装，`family-score` 依赖它。

常用命令：

```bash
docker compose ps                 # 查看各服务状态
docker compose logs -f core       # 查看平台核心日志
docker compose up -d --build      # 改了平台本体的代码后重新构建并启动，不影响模块
docker compose down               # 停止平台本体（数据保留在卷里）；模块容器不受影响
scripts/module list               # 查看已安装的模块
scripts/module install x.zip      # 在命令行安装模块包，和在门户上传一样
```

## 家人在局域网访问

1. 在路由器里给这台电脑固定一个局域网 IP。
2. 在 Windows 防火墙里为 8080 端口添加入站规则，只允许“专用”网络。
3. 家人的手机、iPad、电脑连同一个 Wi-Fi，打开 `http://<电脑的局域网IP>:8080`。

路由器上不要为 8080 做端口转发，平台目前不应暴露到公网。

## 开发一个新模块

每个模块一个仓库。规范见 [docs/module-spec.md](docs/module-spec.md)，大致流程（需要 Node.js 20 以上和 Docker，平台要先跑起来）：

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
