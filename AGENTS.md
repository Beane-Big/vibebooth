# 仓库约定（给 AI 编码工具和自己看）

- 文档和代码一起改：
  - 改了服务、路由、登录流程或模块机制，同步更新 `ARCHITECTURE.md`。
  - 改了 `docker-compose.yml`、`.env.example`、Dockerfile、`scripts/` 或启动步骤，同步更新 `DEPLOY.md` 和 `README.md` 里受影响的部分。
- 所有模块都要遵守的开发规范写在 `docs/module-spec.md`，改了清单格式、安装器规则或菜单权限要同步更新它；规则收紧、老的模块包会装不上时，把 `packages/manifest` 的 `SupportedPlatform` 和规范版本一起加 1。模块不在这个仓库里：每个模块一个仓库，由脚手架 create-vibebooth 生成，各自的约定写在模块仓库的 `AGENTS.md`。
- 改了 `packages/sdk-go` 要发新版本时，在 main 上打标签 `packages/sdk-go/vX.Y.Z`，模块按标签引用它；同时更新 create-vibebooth 里的 `sdkVersion`。
- 改了 `installer/` 或 `packages/manifest` 要发新版本时，在 main 上打标签 `installer/vX.Y.Z`，GitHub Actions 会把安装器镜像发布为 `ghcr.io/beane-big/vibebooth-installer:X.Y.Z`，模块仓库在本机没有平台时用它打包；同时更新 create-vibebooth 里的 `installerVersion`。
