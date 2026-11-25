# Vibebooth

一个专为 AI 时代打造的**私人应用空间**——把你用 AI（Vibe Coding）做出的小工具、家庭应用和创意作品，装进一个属于自己或家人的专属网站里，随时在电脑和手机上打开使用。

- **在线体验**：<https://myapps.vibebooth.cn/>

## 你能用 Vibebooth 做什么

- **装进你的专属应用**：不管是突如其来的日常创意、随手实现的灵感小工具，还是各类 Vibe Coding 作品，上传即可安装使用，互不干扰。
- **不会写代码也能做应用**：内置「应用开发」与「主题开发」指引和 AI 开发 Skill，用自然语言向 AI 描述想法，生成后拖进页面就能自动安装上线。
- **个性化门户外观**：自由定制网站名称、图标、主题风格和壁纸，打造只属于自己的主页。
- **家人与好友共享**：支持多账号、联系人与精细权限管理，实时站内通知及 Bark / 飞书 / 企微 / 钉钉等离线消息推送。
- **数据完全掌握在自己手里**：部署在自己的电脑、NAS 或云服务器上，支持在网页端一键备份与定时备份。

---

## 第一次使用步骤

运行 Vibebooth **不需要预先安装 Node.js、Go 或数据库**；即使还没装 Docker，一键脚本也会自动帮你安装并启动。

### 1. 一键安装并启动

根据你的电脑或服务器系统，打开命令行窗口，粘贴并运行对应的一条命令：

- **Windows（在开始菜单打开 PowerShell）**：

  ```powershell
  irm https://raw.githubusercontent.com/Beane-Big/vibebooth/main/scripts/install.ps1 | iex
  ```

  > 未安装 Docker 时会自动安装并打开 Docker Desktop；如果首次安装提示需要重启电脑，重启后再执行一次上面的命令即可。

- **macOS / Linux / 云服务器 / NAS / WSL Ubuntu（打开终端）**：

  ```bash
  curl -fsSL https://raw.githubusercontent.com/Beane-Big/vibebooth/main/scripts/install.sh | bash
  ```

  > Linux 会自动安装 Docker 并按网络环境自动配置国内加速源；macOS 已安装 Homebrew 时会自动安装并启动 Docker Desktop（未安装 Homebrew 时会提示安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 或 [OrbStack](https://orbstack.dev/)，装好后重新运行一次即可）。

> 如果你已经把代码下载到了本地目录，可以直接运行 `bash scripts/install.sh`（macOS / Linux）或 `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`（Windows）。

### 2. 打开浏览器并登录

启动完成后，窗口里会显示访问地址和首次自动生成的管理员账号密码：

1. 在浏览器打开 <http://localhost:8080>。
2. 使用终端里打印的 `admin` 账号和初始密码登录。

### 3. 按首页「新手指引」完成初始配置

首次登录后，首页会显示新手指引，按步骤点几下就能完成个性化设置：

- **修改默认密码**：在「联系人 → 我」里把初始密码改成自己的密码。
- **自定义站点与通知**：在「设置」里修改平台名称、图标，按需开启消息推送（如手机 Bark、企业微信、飞书或钉钉通知）。
- **开启自动备份**：在「设置 → 数据备份」里设置定时备份或远程备份，保护你的所有应用数据。

### 4. 用 AI 做出并安装你的第一个应用

1. 打开「应用管理 → 应用开发」，点击下载 **应用开发 Skill**。
2. 把下载的 Skill 交给你的 AI 助手，直接用自然语言描述想做的应用（页面里也准备了现成的提示词模板可直接复制）。
3. 把 AI 生成的压缩包拖进「应用管理 → 应用构建」，等待构建完成后点一下「安装」，新应用就会立刻出现在首页。

### 5. 定制专属外观并分享给家人

- **换主题 / 换壁纸**：打开「外观」，可以直接切换喜欢的主题和壁纸，也可以在「外观 → 主题开发」里下载主题 Skill 让 AI 帮你定制一套专属风格。
- **手机和家人一起用**：让手机、平板连上同一个 Wi-Fi，用安装完成后提示的**局域网地址**（`http://<你的局域网IP>:8080`）就能直接打开使用；在「联系人」里可以给家人创建账号。

---

## 日常常用操作

在安装目录（默认 `~/vibebooth` 或 `%USERPROFILE%\vibebooth`）中执行：

```bash
docker compose ps             # 查看运行状态
docker compose down           # 停止服务（数据会保留，不会丢失）
docker compose up -d          # 重新启动服务
```
