# Vibebooth 主题规范（给 AI 编码工具和自己看）

> 规范版本：`platform: 1`。门户给主题的接口（`window.vibebooth`）有不兼容的改动时加 1；新增可选字段不加。

主题换的是门户的外观：颜色、页面背景、表单和卡片等组件的样式、玻璃效果，以及首页的应用列表。主题只有前端文件，没有容器。每个主题一个仓库，主题自己的约定写在仓库根目录的 `AGENTS.md`。

主题只作用于门户和它自带的页面（首页、用户、设置）。模块的页面在 iframe 里，不受主题影响。

## 开发流程

1. `npx github:Beane-Big/create-vibebooth theme <id>`：生成主题仓库 `vibebooth-theme-<id>/`，里面是一个能直接用的玻璃效果示例。
2. `npm run dev`：本机预览，模拟门户的顶栏、首页和常见组件，可切换深浅色。不需要本机有平台。
3. `npm run install:local`：打包并装到本机平台（要 Docker 和本机平台），在头像菜单的“皮肤”里选用。
4. `npm run pack` 生成的 `dist/<id>-<版本>.zip` 就是要上传到正式平台“设置 → 主题”页的主题包。改了代码要发布时先改 `theme.yaml` 的 `version`。

## 主题包

zip 根目录：

| 文件 | 说明 |
| --- | --- |
| `theme.yaml` | 清单，见下 |
| `theme.js` | 主题的脚本（IIFE 格式），清单的 `script` |
| `theme.css` | 主题的样式表，清单的 `style` |
| 预览图 | 清单的 `preview`，`.svg`、`.png`、`.jpg`、`.webp` |
| `assets/` | 图片、字体等附带文件 |

```yaml
platform: 1
id: aurora
name: "极光"
description: "渐变背景和玻璃效果"
version: 0.1.0
script: theme.js
style: theme.css
preview: preview.svg
```

## 安装器检查的规则

- **id**：和模块 id 的规则一样（小写字母开头，只含小写字母、数字和连字符，2 到 31 个字符），不能是内置皮肤的 `classic`、`tiles`。主题 id 和模块 id 是两套，可以重名，但最好不要。装上以后不要再改 id，改了就是另一个主题，选了旧主题的人会退回经典皮肤。
- **规范版本**：`platform` 不填为 1，比平台支持的版本高时拒绝安装。
- **版本**：`version` 是 `x.y.z`。门户按版本号区分缓存，改了内容不改版本，浏览器可能还用旧的（最多 5 分钟）。
- **文件**：`script` 和 `style` 至少有一个，`script` 是 `.js`，`style` 是 `.css`，都是根目录下的文件名。根目录只能有 `theme.yaml` 和清单声明的文件，其余文件放 `assets/` 下，类型限 `.svg .png .jpg .webp .gif .woff .woff2 .css .js .json`，文件名不能以 `.` 开头。清单不认识的字段视为错误。
- **大小**：解压后不超过 20 MB，上传的 zip 不超过 25 MB。
- **脚本要确认**：带 `script` 的主题，管理员要在页面上确认（命令行 `installer install-theme <zip> --allow-script`）才安装。没有声明 `script` 的主题，`assets/` 里也不能有 `.js`。

只有有“应用管理”权限的人能安装和卸载主题。装好的主题所有登录的人都能选用，每个人在头像菜单的“皮肤”里选，选择存在自己的浏览器里。

## 安全

主题的脚本在门户里以使用者的身份运行，能看到和操作他在平台上能看到的一切，和门户自己的代码没有区别。所以：

- 只安装自己做的或可信来源的主题，安装时的确认就是为此。
- 主题不加载远程脚本、样式和字体，也不请求平台以外的网址。
- 主题出错（脚本加载失败、没有注册、首页组件抛错）时，门户提示是哪个主题出的错，退回经典皮肤显示；选用的主题被卸载了也退回经典皮肤。

## 门户给主题的接口

门户在加载主题前设置 `window.vibebooth`：

| 字段 | 说明 |
| --- | --- |
| `platform` | 门户支持的主题规范版本 |
| `React`、`jsxRuntime` | 门户自己的 React，主题必须用这一份，组件才能和门户的组件互相嵌套 |
| `antd` | 门户共享的 Ant Design 组件：`Alert Avatar Badge Button Card Checkbox Col Empty Flex Form Grid Input Row Segmented Select Space Spin Tag Tooltip Typography theme`，跟着门户的主题参数显示 |
| `registerTheme(def)` | 主题的脚本加载时同步调用一次，门户从当前 `<script>` 的 `data-theme` 认出是哪个主题 |

脚手架生成的主题在构建时把 `react`、`react/jsx-runtime`、`antd` 指向这几个全局变量，不打进主题。类型定义在主题仓库的 `src/vibebooth.d.ts`，和门户的 `portal/src/themeHost.tsx`、`portal/src/theme.tsx` 一致。

`def` 的每一项都可以不写，不写的部分用经典皮肤的：

| 字段 | 说明 |
| --- | --- |
| `tokens` | 门户的颜色参数，深浅色各一份（`{light, dark}`）：主色、错误/成功/警告色、文字、页面底色、卡片底色、边框、卡片/弹出层/悬浮顶栏的阴影、输入框底边。只写要改的 |
| `antd` | Ant Design 的参数，深浅色各一份：`token` 是全局的（字号、圆角、控件高度、字体……），`components` 按组件调（`Input`、`Select`、`Button`、`Card`、`Typography`……）。在门户默认参数上合并 |
| `background` | 页面背景，CSS `background` 写法，深浅色各一份。图片用主题包里的 `assets/` 文件 |
| `glass` | 玻璃效果，`true` 或 `{blur, opacity}`：卡片、顶栏、弹出层、菜单的底色变半透明（`opacity` 默认 0.6），并模糊后面的背景（`blur` 默认 20px）。和 `background` 一起用效果才明显 |
| `Home` | 替换首页应用列表的 React 组件，见下 |

### 首页组件

`Home` 收到 `{apps, dark, user}`：

- `apps`：首页上的应用，平台自带的应用（用户、设置）和模块统一成一种，已按当前用户的权限过滤。每个有 `id name description url healthy builtin link`；模块有 `icon`（图片网址），平台自带的应用有 `glyph`（图标元素）和建议的渐变底色 `tint`。
- `link` 原样展开到 `<a>` 上：普通点击在门户里以标签页打开，按住 Ctrl / Cmd 或中键在浏览器新标签页打开。不要自己拼网址或另写跳转。
- `healthy` 为 false 的应用要看得出不可用。
- `dark` 是当前是否深色，`user.displayName` 是当前用户的名字。

## 样式表

选用主题时门户加载它的样式表，换掉或不用时移走；门户顶层有 class `skin-theme theme-<id>`。

- 规则以 `.theme-<id>` 开头，或者只用在主题自己的 class 上，不写会影响其他主题的全局规则。
- 门户里能改的元素只有这几个，其他 class 随时会改：`.topbar`（顶栏）、`.brand`（平台名称）、`.app-tabbar`（标签栏）、`.content`（内容区）。表单、卡片等组件用 `antd` 参数调，不要覆盖 `.ant-*`。
- 颜色用门户的 CSS 变量，深浅色切换时自动跟着变：`--accent`（主色）、`--text`、`--muted`（次要文字）、`--bg`（页面底色）、`--surface`（卡片底色，玻璃效果下是半透明的）、`--border`、`--danger`、`--radius`、`--shadow`、`--float-shadow`、`--glass-blur`。
- 样式表里引用 `assets/` 下的文件用相对路径。

## 平台怎么加载主题

1. 安装器把主题解压到 `modules-data` 卷的 `.themes/<id>/`（先解到暂存目录再换上，升级时不会半新半旧）。
2. 平台核心 `GET /api/platform/themes` 列出已安装的主题，`GET /api/platform/themes/<id>/<文件>` 发主题包里的文件（只发清单声明的文件和 `assets/` 下的文件），都要登录。主题文件带 `Content-Security-Policy: sandbox` 响应头，直接在浏览器里打开时（比如嵌了脚本的 SVG）不会运行脚本。
3. 门户读到当前皮肤是 `theme:<id>` 时，插入 `<script data-theme="<id>">` 加载脚本，拿到注册的内容后套上颜色参数、背景、玻璃效果和首页组件，再挂上样式表。
