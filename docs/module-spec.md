# Vibebooth 模块开发规范（给 AI 编码工具和自己看）

> 规范版本：`platform: 1`。规则收紧、老的模块包会装不上时版本加 1；新增可选字段不加。

平台只规定模块和平台怎么交接；语言、框架、库表设计由模块自己决定。下面标“安装器检查”的规则，不符合时 `npm run pack` 在本地就会报错，平台也会拒绝安装。每个模块一个仓库，模块自己的约定写在仓库根目录的 `AGENTS.md`。

## 开发流程

1. `npx github:Beane-Big/create-vibebooth <id>`：生成模块仓库 `vibebooth-module-<id>/`，选好前端和后端的技术栈。
2. 写代码。平台要先用 `docker compose up -d --build` 跑起来。
3. `npm run install:local`：在本地构建镜像、打包、装到本地平台。改了代码再运行一次即可，只重建这一个模块。
4. 验证没问题后，`npm run pack` 生成的 `dist/<id>-<版本>.zip` 就是要上传到正式平台“应用管理”页的模块包。`npm run pack` 不需要本机有平台，没有时会下载发布版的安装器镜像。改了代码要发布时先改 `module.yaml` 的 `version`。

## 安装器检查的规则

- **id**：小写字母开头，只含小写字母、数字和连字符，2 到 31 个字符；装上以后不能再改，改了就是另一个模块；不能用 `platform`、`core`、`portal`、`traefik`、`postgres`、`socket`、`installer`。
- **规范版本**：`platform` 写模块遵循的规范版本，不填为 1。比平台支持的版本高时拒绝安装，提示先升级平台。
- **版本**：`version` 是 `x.y.z`。镜像名固定为 `vb-<id>-<服务>:<版本>`，开发用的 `compose.yaml` 里写 `image: vb-<id>-backend:${VERSION}`，打包时换成真实版本号。
- **容器**：对外的服务只能是 `<id>-frontend`（接 `/apps/<id>/`）和 `<id>-backend`（接 `/api/<id>/`），在 `module.yaml` 的 `services` 里写端口；可以再有 `<id>-<名字>` 形式的辅助容器，它们不对外。
- **compose.yaml 允许的字段**：`image`、`build`（打包时去掉）、`environment`、`command`、`volumes`、`depends_on`、`healthcheck`、`restart`、`user`；顶层只能有 `services` 和 `volumes`。不能有端口映射、特权、宿主机网络、标签、挂载宿主机目录；除了 `image` 里的 `${VERSION}`，文件里不能出现 `$`，环境变量必须写明取值。
- **每个服务都要从模块仓库构建**：每个服务都要写 `build`，可以是目录（如 `./backend`），也可以是只含 `context` 和 `dockerfile` 的映射；路径必须是模块仓库里的相对路径，不能是网址、绝对路径或用 `..` 跳出仓库，`dockerfile` 相对于 `context`。打包和构建器在服务器上构建都按这个找 Dockerfile。
- **网关路由**：不要自己写 Traefik 标签，安装器按 `services` 自动生成，并补上网络 `platform` 和 `JWKS_URL`。
- **健康检查**：后端提供 `GET /api/<id>/health`，正常时返回 2xx，不需要令牌。安装后 60 秒内不通过就算安装失败。
- **菜单**：有前端时 `module.yaml` 至少声明一个 `menus`，`path` 都在 `/apps/<id>/` 下；`default` 是默认拥有它的角色（`user` 或 `admin`），`settings: true` 的菜单会出现在门户“设置”页。需要单独控制的页面放在子路径下，模块首页对有任一菜单的人都开放。
- **依赖**：要调用其他模块的对外接口，就在 `requires` 里写上对方的 id；用到了对方某个版本才有的接口时写成 `contacts>=0.2`。依赖没装或版本不够时拒绝安装；已经被依赖的模块也不能装回不满足依赖的旧版本。
- **可选依赖**：对方没装时本模块也能用（只是少一部分功能），就写在 `optional` 里，写法和 `requires` 一样，同一个模块不能两边都写。没装照样能安装，装了就必须满足版本；对方可以随时卸载，本模块要自己处理对方不在的情况（调用失败时降级，页面上说明要装什么）。
- **特权**：`privileges` 声明模块需要的平台特权，目前只有 `docker-build`：后端可以通过 `DOCKER_HOST`（由平台设置）访问构建代理，构建 `vb-` 开头的镜像，并查看、打标签、导出、删除这些镜像。安装时管理员要在页面上确认，命令行要加 `--allow-privileges`。普通模块不要写。

## 编码约定

- 只读写本模块仓库和本模块自己的数据（`volumes` 里声明的卷，安装后卷名是 `mod-<id>_<卷名>`）。默认用 SQLite 文件放在卷里。
- 不写登录代码。后端用 SDK `github.com/Beane-Big/vibebooth/packages/sdk-go/auth` 校验网关注入的令牌（`go.mod` 里按版本引用，例如 `v0.1.0`，对应平台仓库的标签 `packages/sdk-go/v0.1.0`），不自己解析请求头里的用户信息；其他语言要按同样的规则用 JWKS 公钥验签（RS256，`iss` 是 `home-platform`，`aud` 是模块 id）。
- 接口权限用令牌里的菜单判断（Go 里是 `auth.UserFrom(ctx).HasMenu("<菜单 id>")`），不要用角色判断。
- 跨模块只调用对方 `/api/<id>/ext/v1/` 下的对外接口，不 import 其他模块的代码，也不读别人的数据。对外接口的契约写在 `contracts/openapi.yaml`，不兼容的改动新开 v2。
- 前端沿用脚手架生成的 `styles.css` 里的样式变量；共享 UI 组件包做出来后优先用它。页面要适配手机和平板。
- 门户在自己的标签页里以内嵌页（iframe）打开应用，按住 Ctrl / Cmd 点击时在浏览器新标签页打开，两种都要能用。不要设置禁止被嵌入的响应头（`X-Frame-Options`、CSP 的 `frame-ancestors`）。应用里不放回门户的链接，回门户用门户的标签栏；应用内部页面之间的返回由应用自己实现。
