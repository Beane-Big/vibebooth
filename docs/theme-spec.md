# Vibebooth 主题规范（给 AI 编码工具和自己看）

> 规范版本：`platform: 1`。门户给主题的接口（`window.vibebooth`）有不兼容的改动时加 1；新增可选字段不加。

主题换的是门户的外观：颜色、页面背景、表单和卡片等组件的样式、玻璃效果，以及首页的应用列表。主题只有前端文件，没有容器。每个主题一个仓库，主题自己的约定写在仓库根目录的 `AGENTS.md`。

主题只作用于门户和它自带的页面（首页、用户、设置）。模块的页面在 iframe 里，不受主题影响。

## 开发流程

1. `npx github:Beane-Big/create-vibebooth-theme <id>`：生成主题仓库 `vibebooth-theme-<id>/`，里面是一个能直接用的玻璃效果示例。
2. `npm run dev`：本机预览，模拟门户的顶栏、首页和常见组件，可切换深浅色。不需要本机有平台。
3. `npm run install:local`：打包并装到本机平台（要 Docker 和本机平台），在“主题”应用里选用。
4. `npm run pack` 生成的 `dist/<id>-<版本>.zip` 就是要上传到正式平台“主题”应用的主题包。它会先截一张预览页的图作为截图。改了代码要发布时先改 `theme.yaml` 的 `version`。

## 主题包

zip 根目录：

| 文件 | 说明 |
| --- | --- |
| `theme.yaml` | 清单，见下 |
| `theme.js` | 主题的脚本（IIFE 格式），清单的 `script` |
| `theme.css` | 主题的样式表，清单的 `style` |
| 截图 | 清单的 `preview`，`.png`、`.jpg`、`.webp`（也接受 `.svg`），“主题”应用里显示它，应该是主题真实的页面截图，建议 1280×800 |
| `assets/` | 图片、字体等附带文件 |

```yaml
platform: 1
id: aurora
name: "极光"
description: "渐变背景和玻璃效果"
version: 0.1.0
script: theme.js
style: theme.css
preview: preview.png
```

## 安装器检查的规则

- **id**：和模块 id 的规则一样（小写字母开头，只含小写字母、数字和连字符，2 到 31 个字符），不能是内置皮肤的 `classic`、`tiles`。主题 id 和模块 id 是两套，可以重名，但最好不要。装上以后不要再改 id，改了就是另一个主题，选了旧主题的人会退回经典皮肤。
- **规范版本**：`platform` 不填为 1，比平台支持的版本高时拒绝安装。
- **版本**：`version` 是 `x.y.z`。门户按版本号区分缓存，改了内容不改版本，浏览器可能还用旧的（最多 5 分钟）。
- **文件**：`script` 和 `style` 至少有一个，`script` 是 `.js`，`style` 是 `.css`，都是根目录下的文件名。根目录只能有 `theme.yaml` 和清单声明的文件，其余文件放 `assets/` 下，类型限 `.svg .png .jpg .webp .gif .woff .woff2 .css .js .json`，文件名不能以 `.` 开头。清单不认识的字段视为错误。
- **大小**：解压后不超过 20 MB，上传的 zip 不超过 25 MB。
- **脚本要确认**：带 `script` 的主题，管理员要在页面上确认（命令行 `installer install-theme <zip> --allow-script`）才安装。没有声明 `script` 的主题，`assets/` 里也不能有 `.js`。

只有有“应用管理”权限的人能安装和卸载主题。装好的主题所有登录的人都能选用，每个人在首页的“主题”应用里选，选择存在自己的浏览器里；“主题”应用里每个皮肤显示一张截图，内置的“经典”“彩色方块”也在里面。

平台有一个默认皮肤（没设过时是“经典”），有“应用管理”权限的人在“主题”应用里点“设为默认”修改。没有自己选皮肤的人用默认皮肤，管理员改了默认会跟着变；自己选过的人可以点“跟随平台默认”改回来。卸载主题时，自己选了它的人改用平台默认皮肤；它正好是默认皮肤时，默认换回“经典”。

## 安全

主题的脚本在门户里以使用者的身份运行，能看到和操作他在平台上能看到的一切，和门户自己的代码没有区别。所以：

- 只安装自己做的或可信来源的主题，安装时的确认就是为此。
- 主题不加载远程脚本、样式和字体，也不请求平台以外的网址。
- 主题出错（脚本加载失败、没有注册、首页组件抛错）时，门户提示是哪个主题出的错，退回经典皮肤显示；选用的主题被卸载了，退回平台默认皮肤。

## 门户给主题的接口

门户在加载主题前设置 `window.vibebooth`：

| 字段 | 说明 |
| --- | --- |
| `platform` | 门户支持的主题规范版本 |
| `React`、`jsxRuntime` | 门户自己的 React，主题必须用这一份，组件才能和门户的组件互相嵌套 |
| `antd` | 门户共享的 Ant Design 组件：`Alert Avatar Badge Button Card Checkbox Col Empty Flex Form Grid Input Row Segmented Select Space Spin Tag Tooltip Typography theme`，跟着门户的主题参数显示 |
| `AppIcon` | 门户的应用图标组件，按主题的 `icons` 上色。主题自己的首页用 `<AppIcon app={app} />` 画图标，不用自己处理图片和颜色 |
| `registerTheme(def)` | 主题的脚本加载时同步调用一次，门户从当前 `<script>` 的 `data-theme` 认出是哪个主题 |

脚手架生成的主题在构建时把 `react`、`react/jsx-runtime`、`antd` 指向这几个全局变量，不打进主题。类型定义在主题仓库的 `src/vibebooth.d.ts`，和门户的 `portal/src/themeHost.tsx`、`portal/src/theme.tsx` 一致。

`def` 的每一项都可以不写，不写的部分用经典皮肤的：

| 字段 | 说明 |
| --- | --- |
| `tokens` | 门户的颜色参数，深浅色各一份（`{light, dark}`）：主色、错误/成功/警告色、文字、页面底色、卡片底色、边框、卡片/弹出层/悬浮顶栏的阴影、输入框底边。只写要改的 |
| `antd` | Ant Design 的参数，深浅色各一份：`token` 是全局的（字号、圆角、控件高度、字体……），`components` 按组件调（`Input`、`Select`、`Button`、`Card`、`Typography`……）。在门户默认参数上合并 |
| `background` | 页面背景，CSS `background` 写法，深浅色各一份。图片用主题包里的 `assets/` 文件 |
| `glass` | 玻璃效果，`true` 或 `{blur, opacity}`：卡片、顶栏、弹出层、菜单的底色变半透明（`opacity` 默认 0.6），并模糊后面的背景（`blur` 默认 20px）。和 `background` 一起用效果才明显 |
| `icons` | 首页应用图标的颜色，深浅色各一份，`{bg, fg}`：`bg` 是图标的底色，CSS `background` 写法（颜色或渐变），不写用应用自己的底色；`fg` 是图形的颜色，只能是颜色，不写是白色。写了这一项图标就按主题上色，见下 |
| `wordmark` | 顶栏平台字标的颜色，深浅色各一份，每份是 1 到 4 个颜色，从左到右渐变；投影和描边跟着中间的颜色。只认 `#rrggbb`、颜色名和 `rgb()`、`hsl()`、`oklch()` 这类写法。不写是原来的蓝紫粉渐变 |
| `Home` | 替换首页应用列表的 React 组件，见下 |

### 图标怎么跟着主题换颜色

平台加载模块时把它的 `icon.svg` 拆成底色和单色的图形（规则见[模块规范](module-spec.md)的“图标”）。主题写了 `icons` 时，门户用 `bg` 画底、把图形当蒙版涂成 `fg`；平台自带的应用和没有图标的模块，图形就是 Ant Design 图标或名称的第一个字。拆不开的图标（PNG、图形有好几种颜色）照原样显示。

```ts
registerTheme({
  icons: {
    light: { bg: "linear-gradient(150deg, #fdf2ff, #e9ddff)", fg: "#7c4ddb" },
    dark: { bg: "rgba(255, 255, 255, 0.12)", fg: "#e4d7ff" },
  },
  wordmark: { light: ["#7c4ddb", "#e978d8"], dark: ["#c7b4ff", "#ffb3d9"] },
});
```

### 首页组件

`Home` 收到 `{apps, dark, user}`：

- `apps`：首页上的应用，平台自带的应用（用户、设置）和模块统一成一种，已按当前用户的权限过滤。每个有 `id name description url healthy builtin link`；模块有 `icon`（图片网址），图标能拆开时还有图形的网址 `mask` 和底色 `color`；平台自带的应用有 `glyph`（图标元素）和建议的渐变底色 `tint`。
- 图标交给 `window.vibebooth.AppIcon` 画，它会按 `icons` 上色、照顾到没有图片和拆不开的图标。
- `link` 原样展开到 `<a>` 上：普通点击在门户里以标签页打开，按住 Ctrl / Cmd 或中键在浏览器新标签页打开。不要自己拼网址或另写跳转。
- `healthy` 为 false 的应用要看得出不可用。
- `dark` 是当前是否深色，`user.displayName` 是当前用户的名字。

## 样式表

选用主题时门户加载它的样式表，换掉或不用时移走；门户顶层有 class `skin-theme theme-<id>`。

- 规则以 `.theme-<id>` 开头，或者只用在主题自己的 class 上，不写会影响其他主题的全局规则。
- 门户里能改的元素只有这几个，其他 class 随时会改：`.topbar`（顶栏）、`.brand`（平台字标，里面是一张图片，能改大小和间距，颜色用 `wordmark` 改）、`.app-icon`（经典皮肤和 `AppIcon` 的图标，能改大小、圆角和阴影）、`.app-tabbar`（标签栏）、`.content`（内容区）。表单、卡片等组件用 `antd` 参数调，不要覆盖 `.ant-*`。
- 颜色用门户的 CSS 变量，深浅色切换时自动跟着变：`--accent`（主色）、`--text`、`--muted`（次要文字）、`--bg`（页面底色）、`--surface`（卡片底色，玻璃效果下是半透明的）、`--border`、`--danger`、`--radius`、`--shadow`、`--float-shadow`、`--glass-blur`；写了 `icons` 时还有 `--icon-bg`、`--icon-fg`。
- 样式表里引用 `assets/` 下的文件用相对路径。

## 平台怎么加载主题

1. 安装器把主题解压到 `modules-data` 卷的 `.themes/<id>/`（先解到暂存目录再换上，升级时不会半新半旧）。
2. 平台核心 `GET /api/platform/themes` 列出已安装的主题，`GET /api/platform/themes/<id>/<文件>` 发主题包里的文件（只发清单声明的文件和 `assets/` 下的文件），都要登录。`GET /api/platform/appearance` 返回平台默认皮肤 `{defaultSkin}`，`PUT` 同一地址修改，要“应用管理”权限。主题文件带 `Content-Security-Policy: sandbox` 响应头，直接在浏览器里打开时（比如嵌了脚本的 SVG）不会运行脚本。
3. 门户的当前皮肤是自己选的皮肤，没选过就是平台默认皮肤。读到当前皮肤是 `theme:<id>` 时，插入 `<script data-theme="<id>">` 加载脚本，拿到注册的内容后套上颜色参数、背景、玻璃效果和首页组件，再挂上样式表。
