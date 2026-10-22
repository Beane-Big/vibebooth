# family 模块约定（给 AI 编码工具和自己看）

通用规范见 `docs/module-spec.md`，这里只写本模块特有的约定。

- 只读写本模块目录 `modules/family/` 和本模块自己的数据库（卷 `family-data` 里的 SQLite 文件，安装后叫 `mod-family_family-data`）。
- 跨模块只调用对方 `/api/<id>/ext/v1/` 下的对外接口，不 import 其他模块的代码。
- 人员信息归人员管理模块（people）所有：这里只保存 `person_id`，姓名每次通过 `people` 的对外接口获取，不复制人员表。人员模块不可用时，排行榜降级为只显示分数。
- 后端用 `packages/sdk-go/auth` 校验网关注入的令牌，不自己解析请求头里的用户信息。
- 设置页在 `/apps/family/settings/`，对应菜单 `settings`（默认只有管理员有），门户“设置”页只放入口；修改设置的接口由后端检查 `HasMenu("settings")`。
