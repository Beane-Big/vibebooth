---
name: vibebooth-theme-dev
description: 开发、自检并打包符合 Vibebooth 门户主题规范（platform: 1）的主题包（.zip）。当用户要为 Vibebooth 设计或修改门户主题外观（颜色、背景、玻璃效果、首页布局、顶栏风格）并打包上传安装时使用。
---

# Vibebooth 主题开发规范 Skill

本 Skill 让 AI 编码工具直接从零开发符合 Vibebooth 主题规范（`platform: 1`）的门户主题包，无需脚手架或 Docker。开发完成后运行内置脚本自检并打出 `<id>-<version>-theme.zip`，上传到 Vibebooth 的「外观 → 主题」即可立即安装启用。

## 一、主题包结构

主题只有前端静态文件，没有容器。zip 根目录必须满足：

```text
<theme-dir>/
├── theme.yaml          # 必需：主题清单
├── theme.js            # 可选（与 theme.css 至少有一个）：IIFE 脚本
├── theme.css           # 可选（与 theme.js 至少有一个）：作用域样式表
├── preview.svg         # 推荐：预览图（支持 .svg / .png / .jpg / .webp，建议 1280x800 比例）
└── assets/             # 可选：图片、字体等附带静态文件
```

具体最小可用模板见 [references/templates.md](references/templates.md)。

## 二、平台硬性校验规则

1. **`theme.yaml`**：
   - 必填字段：`platform: 1`、`id`、`name`、`version`（`x.y.z`，每次更新调大），且 `script` 与 `style` 至少填一个。
   - `id`：小写字母开头，仅含小写字母、数字和连字符，2–31 位，不能是 `classic`、`tiles`。
   - **不允许写清单之外的未知字段**（安装器严格校验，未知字段会报错）。
   - `script` 须为根目录 `.js` 文件名；`style` 须为根目录 `.css` 文件名；`preview` 须为根目录 `.svg`/`.png`/`.jpg`/`.webp` 文件名。
   - 根目录只允许 `theme.yaml` 与清单中声明的文件，其他附带资源必须放 `assets/` 下（允许后缀：`.svg .png .jpg .webp .gif .woff .woff2 .css .js .json`，文件名不能以 `.` 开头；未声明 `script` 时 `assets/` 中也不能放 `.js`）。
   - 解压后总大小不超过 20 MB，zip 不超过 25 MB。

2. **安全规则**：
   - 不加载任何远程脚本、样式或外部字体，也不请求平台外的网址；所有图片与字体自包含在 `assets/` 里。
   - 仅样式改动时可以只提供 `theme.css`（无需 `theme.js`，安装时也无需二次确认脚本权限）。

3. **门户脚本接口（`window.vibebooth`）**：
   - `theme.js` 使用自执行函数（IIFE），加载时同步调用一次 `window.vibebooth.registerTheme(def)`。
   - `def` 所有字段均可选，未写部分继承经典皮肤：
     - `tokens: { light, dark }`：门户颜色参数（主色、文字、底色、卡片底色、边框、阴影等）。
     - `antd: { light, dark }`：Ant Design `token` 和 `components` 覆盖。
     - `background: { light, dark }`：CSS `background` 写法（纯色、渐变或 `url("assets/...")`）。当用户选了平台壁纸时，页面背景会自动替换为壁纸，因此卡片和文字在照片壁纸上也要清晰可读。
     - `glass: true | { blur, opacity }`：毛玻璃半透明与模糊效果。
     - `icons: { light: { bg, fg }, dark: { bg, fg } }`：统一给首页应用图标重上色。
     - `wordmark: { light: string[], dark: string[] }`：顶栏字标渐变色（1–4 个颜色）。
     - `Home`: 可选 React 组件（使用 `window.vibebooth.React`、`window.vibebooth.antd`、`window.vibebooth.AppIcon`），收到 `{ apps, dark, user, wallpaper }`。每个 `app` 渲染 `<a {...app.link}>`，图标交由 `<AppIcon app={app} />`，`!app.healthy` 时显示不可用态。
     - `TopbarBackground`: 可选 React 组件，收到 `{ dark, wallpaper }`，画在顶栏背后。

4. **样式表约束（`theme.css`）**：
   - 所有选择器必须以 `.theme-<id>` 开头，或只作用于主题自定义 class，避免污染其他主题。
   - 仅调整门户公开容器 class：`.topbar`、`.brand`、`.app-icon`、`.app-tabbar`、`.content`；不要硬覆盖 `.ant-*`。
   - 优先使用门户 CSS 变量：`--accent`、`--text`、`--muted`、`--bg`、`--surface`、`--border`、`--danger`、`--radius`、`--shadow`、`--float-shadow`、`--glass-blur`。

5. **预览图 `preview.svg` / `preview.png`**：
   - 推荐直接生成一张 1280×800（16:10）能真实体现主题配色、背景与卡片风格的 `preview.svg`（不含 `<script>`）。

## 三、自检与打包（交付前必做）

写完主题文件后，在主题目录运行内置自检打包脚本（Node.js 20+，零外部依赖）：

```bash
node <skill目录>/scripts/check-and-pack-theme.mjs .
```

脚本会逐项校验 `theme.yaml`、文件白名单与体积限制，通过后生成 `<id>-<version>-theme.zip`。

最后引导用户在 Vibebooth 打开「外观 → 主题」，将生成的 `.zip` 拖入「安装或升级主题」即可安装并启用。
