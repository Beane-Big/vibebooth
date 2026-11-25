# Vibebooth 平台演进路线图

面向家庭与小团队自托管场景，围绕“非专业用户易安装维护、Vibe Coding 应用快速开发部署、统一平台公共能力”分三个阶段推进。

## 第一阶段：开发与配置体验闭环（已完成）
- **可视化站点设置**（`core/site.go`、`portal/src/pages/Settings.tsx`）：支持后台实时配置产品名称、上传自定义 Logo、备案号、政策链接及开放自助注册开关，实时同步顶栏字标、浏览器标题与图标。
- **Vibe Coding 开发规范 Skill**（`skills/vibebooth-app-dev/`）：提供标准 Agent Skill、最小前后端模板以及零依赖自检打包脚本 `scripts/check-and-pack.mjs`，并在「应用管理 → 应用构建」提供一键下载（`GET /api/platform/builder/skill`）。
- **构建器诊断与 AI 修复闭环**（`builder/diagnose.go`、`portal/src/pages/builder/Home.tsx`）：自动识别 Go / npm / PyPI 镜像超时、磁盘空间不足、内存不足等问题，提供「一键配置国内源」「清理构建缓存」和「复制给 AI 修复」按钮。

## 第二阶段：易安装维护 + 平台消息推送底座（核心已落地）
- **平台消息推送底座 V1**（`core/notifications.go`、`portal/src/components/NotificationBell.tsx`）：
  - 站内通知中心 + SSE 实时推送流（`/api/platform/notifications/stream`），点击直达对应模块或平台页面。
  - 外部离线推送通道：支持个人通道与管理员系统通道（Bark、企业微信、飞书、钉钉、通用 Webhook），支持后台一键测试；在线时走站内提醒，离线时触发站外兜底。
  - 统一内部接口 `POST http://core:8080/api/platform/ext/v1/notifications`，已接入联系人好友请求/通过与构建器结果通知，供未来论坛、意见箱、联系人私信等模块直接调用。
- **容器保护与运维脚本**：
  - 安装器默认给所有模块容器开启日志轮转（`max-size: 10m`，`max-file: 3`）。
  - 预构建多架构镜像发布工作流（`.github/workflows/platform-images.yml`）与 `docker-compose.prebuilt.yml`。
  - 一键安装脚本（`scripts/install.sh`）与一键备份恢复脚本（`scripts/backup.sh`）。
- **待续项**：Web 首次启动初始化向导（Setup Wizard）、Web 端一键备份下载与自动 HTTPS 域名配置。

## 第三阶段：更轻量的应用托管与公共能力（规划中）
- **零 Dockerfile 预设构建**：支持 `module.yaml` 声明运行时（静态页 / Vite / Node / Python / Go），未提供 Dockerfile 时由构建器套用官方模板自动构建。
- **0 级纯前端免容器静态托管**：纯前端工具免独立 Nginx 容器，秒级安装、零常驻内存开销。
- **平台托管轻量数据存储（App KV）**：纯前端应用无需自建后端即可按用户隔离并同步数据。
- **统一 AI 模型代理（AI Gateway）与 Web Push（VAPID）**：统一管理大模型 API Key 与家庭调用配额；配合自动 HTTPS 支持 PWA 锁屏推送。
