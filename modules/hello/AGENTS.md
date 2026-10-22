# hello 模块约定（给 AI 编码工具和自己看）

通用规范见 `docs/module-spec.md`，这里只写本模块特有的约定。

- 只读写本模块目录 `modules/hello/` 和本模块自己的数据库。
- 跨模块只调用对方 `/api/<id>/ext/v1/` 下的对外接口，不 import 其他模块的代码。
- 后端用 `packages/sdk-go/auth` 校验网关注入的令牌，不自己解析请求头里的用户信息。
- 改了对外接口就同步更新 `contracts/openapi.yaml`；不兼容的改动新开 v2。
