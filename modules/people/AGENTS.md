# people 模块约定（给 AI 编码工具和自己看）

- 只读写本模块目录 `modules/people/` 和本模块自己的数据库（卷 `people-data` 里的 SQLite 文件）。
- 跨模块只调用对方 `/api/<id>/ext/v1/` 下的对外接口，不 import 其他模块的代码。
- 后端用 `packages/sdk-go/auth` 校验网关注入的令牌，不自己解析请求头里的用户信息。
- 对外接口 `/api/people/ext/v1/` 由其他模块在内部网络直接调用，网关不转发；目前没有服务令牌，只返回其他模块需要的字段（id、姓名、照片），备注不对外。
- 改了对外接口就同步更新 `contracts/openapi.yaml`；不兼容的改动新开 v2。
