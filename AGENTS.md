# 仓库约定（给 AI 编码工具和自己看）

- 文档和代码一起改：
  - 改了服务、路由、登录流程或模块机制，同步更新 `ARCHITECTURE.md`。
  - 改了 `docker-compose.yml`、`.env.example`、Dockerfile、`scripts/` 或启动步骤，同步更新 `DEPLOY.md` 和 `README.md` 里受影响的部分。
- 所有模块都要遵守的开发规范写在 `docs/module-spec.md`，改了清单格式、安装器规则或权限要同步更新它；规则收紧、老的模块包会装不上时，把 `packages/manifest` 的 `SupportedPlatform` 和规范版本一起加 1。模块不在这个仓库里：每个模块一个仓库，由脚手架 create-vibebooth 生成，各自的约定写在模块仓库的 `AGENTS.md`。
- 门户主题的规范写在 `docs/theme-spec.md`。改了门户给主题的接口（`portal/src/themeHost.tsx` 的 `window.vibebooth`、`portal/src/theme.tsx` 的 `ThemeOverrides`）或 `packages/manifest/theme.go` 的规则，要同步更新它和脚手架 `templates/theme/src/vibebooth.d.ts`；不兼容的改动把 `SupportedThemePlatform`、门户的 `THEME_PLATFORM` 和规范版本一起加 1。
- 改了 `packages/sdk-go` 要发新版本时，在 main 上打标签 `packages/sdk-go/vX.Y.Z`，模块按标签引用它；同时更新 create-vibebooth 里的 `sdkVersion`。
- 改了 `installer/`、`packages/manifest` 或 `packages/modpkg` 要发新版本时，在 main 上打标签 `installer/vX.Y.Z`，GitHub Actions 会把安装器镜像发布为 `ghcr.io/beane-big/vibebooth-installer:X.Y.Z`，模块仓库在本机没有平台时用它打包；同时更新 create-vibebooth 里的 `installerVersion`。
- 构建器模块按标签引用 `packages/manifest` 和 `packages/modpkg`：改了它们要发新版本时，分别打标签 `packages/manifest/vX.Y.Z`、`packages/modpkg/vX.Y.Z`，再更新构建器仓库的 `go.mod`。`packages/modpkg/go.mod` 里对 manifest 的版本要写和它一起发布的那个标签，否则构建器下载不到。
