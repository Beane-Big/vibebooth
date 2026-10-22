# 仓库约定（给 AI 编码工具和自己看）

- 文档和代码一起改：
  - 改了服务、路由、登录流程或模块机制，同步更新 `ARCHITECTURE.md`。
  - 改了 `docker-compose.yml`、`.env.example`、Dockerfile、`scripts/` 或启动步骤，同步更新 `DEPLOY.md` 和 `README.md` 里受影响的部分。
- 所有模块都要遵守的开发规范写在 `docs/module-spec.md`，改了清单格式、安装器规则或菜单权限要同步更新它；规则收紧、老的模块包会装不上时，把 `packages/manifest` 的 `SupportedPlatform` 和规范版本一起加 1；各模块自己的约定写在 `modules/<id>/AGENTS.md`。
