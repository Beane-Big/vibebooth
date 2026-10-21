# 仓库约定（给 AI 编码工具和自己看）

- 文档和代码一起改：
  - 改了服务、路由、登录流程或模块机制，同步更新 `ARCHITECTURE.md`。
  - 改了 `docker-compose.yml`、`.env.example`、Dockerfile 或启动步骤，同步更新 `DEPLOY.md` 和 `README.md` 里受影响的部分。
- 各模块自己的约定写在 `modules/<id>/AGENTS.md`。
