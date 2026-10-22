# Vibebooth 部署文档（Windows + WSL）

> 2026-10-21 在公司电脑上实际部署过一遍，这份文档按当时真实走通的路线整理，踩过的坑都写进去了。

整个流程分 6 步，顺利的话 1 小时内能在浏览器里打开 `http://localhost:8080` 并登录。如果之前已经按旧版本部署过，代码更新后先看文末的“从旧版本迁移”。

1. 装 WSL（Windows 里的 Ubuntu）
2. 在 Ubuntu 里装 Docker
3. 让 Docker 能连上外网（开代理）
4. 下载代码（需要 GitHub 令牌）
5. 填配置文件 `.env`
6. 启动并访问

**约定：** 灰底的命令复制后粘贴到 Ubuntu 窗口里（右键即粘贴），按回车运行。输入密码时屏幕不显示任何字符，这是正常的。

---

## 第 1 步：装 WSL 和 Ubuntu

1. 在开始菜单搜索 **PowerShell**，右键选择“以管理员身份运行”。
2. 输入：

   ```powershell
   wsl --install -d Ubuntu
   ```

3. 装完后按提示**重启电脑**。
4. 重启后 Ubuntu 窗口会自动弹出；如果没有，就在开始菜单里搜 **Ubuntu** 打开。按提示设置用户名和密码，这个密码之后用 `sudo` 时会用到。
5. 检查：在 PowerShell 里运行 `wsl -l -v`，看到 Ubuntu 那一行的 VERSION 是 **2** 就对了。

版本选择：上面的命令会自动安装默认的 LTS 版本。如果从 Microsoft Store 手动装，选 **Ubuntu 24.04 LTS**。装好后可以在 Ubuntu 里运行 `lsb_release -a` 确认版本。

## 第 2 步：在 Ubuntu 里装 Docker

这里用的是直接在 Ubuntu 里装 Docker 的方式，免费开源，不需要 Docker Desktop。在 Ubuntu 里运行：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

运行完**关掉 Ubuntu 窗口再重新打开**，让第二条命令给的权限生效。

> 如果这一步下载就失败了，先做第 3 步开代理，然后回来重新运行。

## 第 3 步：让 Docker 能连上外网

不开代理时，Docker 会报这样的错：

```
dial tcp 69.171.247.32:443: i/o timeout
```

或者：

```
failed to fetch anonymous token ... EOF
```

意思是连不上 Docker Hub。后面构建时要从 npm 和 Go 官方源下载依赖，这些源同样需要代理。

**实际走通的做法：**

1. 打开 Windows 上的代理软件（比如 Clash Verge），开启 **TUN 模式**（有的版本叫“虚拟网卡模式”）。
2. 把代理模式切到 **全局（Global）**。只开规则模式时，`auth.docker.io` 在下载中途断开过。
3. 在 Ubuntu 里运行下面这条，看到 `Hello from Docker!` 就说明 Docker 装好了，网络也通了：

   ```bash
   docker run hello-world
   ```

> 不要把 Docker 的代理地址写成 `127.0.0.1:7897`。在 WSL 里，`127.0.0.1` 指的是 Ubuntu 自己，不是 Windows。开了 TUN 模式就不需要给 Docker 单独配代理。
>
> 如果之前在 `/etc/systemd/system/docker.service.d/proxy.conf` 里写过代理配置，先删掉它：
> ```bash
> sudo rm -f /etc/systemd/system/docker.service.d/proxy.conf
> sudo systemctl daemon-reload && sudo systemctl restart docker
> ```

## 第 4 步：下载代码

仓库是**私有的**，GitHub 不接受用登录密码 clone，要先生成一个访问令牌。

**生成令牌（在浏览器里操作）：**

1. 打开 <https://github.com/settings/personal-access-tokens/new>
2. Token name 随便填，例如 `home-pc`；Expiration 选 30 天。
3. Repository access 选 **Only select repositories**，然后选 `vibebooth`（以前叫 home-platform）、`vibebooth-module-people` 和 `vibebooth-module-family-score`。以后新建了模块仓库，也要回到这里把它加上。
4. 在 Permissions 里把 **Contents** 设为 **Read-only**。
5. 点 Generate token，**马上复制**。离开这个页面后就再也看不到了。

**clone 代码：**

```bash
git clone https://github.com/Beane-Big/vibebooth.git ~/home-platform
cd ~/home-platform
```

- Username 填 `Beane-Big`
- Password 填刚才复制的令牌（右键粘贴，屏幕上不会显示），然后回车

> 令牌就相当于密码，不要发给任何人。用完可以在同一个页面删掉。
>
> 代码要放在 `~/home-platform`，不要放在 `/mnt/c/` 下面，那里读写慢，也容易出权限问题。想用 Windows 资源管理器查看这些文件，在项目文件夹里运行 `explorer.exe .` 就行。

**令牌找不到了怎么办：** 令牌只在生成时显示一次，之后 GitHub 不会再显示。丢了就按上面的步骤重新生成一个，旧的可以在 <https://github.com/settings/personal-access-tokens> 里删掉。

**不想每次都输入令牌（可选）：** 在 Ubuntu 里执行一次：

```bash
git config --global credential.helper store
```

下次 clone 或 pull 时输入一次，之后就会记住。注意令牌会以明文保存在 `~/.git-credentials`。令牌只有这几个仓库的只读权限，风险不大，但在公司电脑上要自己判断要不要用。

## 第 5 步：填配置文件 .env

`.env` 是一个写设置的文本文件，这一步只需要填两个密码：

- **数据库密码**：平时用不到，自动生成一个随机的就行。
- **管理员密码**：登录网页时用。

不用自己装数据库，第 6 步启动时 Docker 会自动建好。

在 `~/home-platform` 里运行（第 3 行的 `Admin2026abc` 可以先换成你自己的密码，只用字母和数字，至少 8 位）：

```bash
cp .env.example .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=Admin2026abc/" .env
grep PASSWORD .env
```

最后一行会把两项密码打印出来，两行等号后面都有值就说明设置成功了。

> 管理员账号只在**第一次启动**时创建。之后再改 `ADMIN_PASSWORD` 不会生效，除非用 `docker compose down -v` 清空所有数据重来。

## 第 6 步：启动并访问

1. 先把现成的镜像逐个下载下来。一次只下一个更稳，哪条失败就重新运行哪条：

   ```bash
   docker pull tecnativa/docker-socket-proxy:v0.4.1
   docker pull traefik:v3.6
   docker pull postgres:17-alpine
   docker pull docker:29-cli
   ```

2. 构建并启动平台本体。第一次运行要几分钟，屏幕上滚过很多输出是正常的：

   ```bash
   cd ~/home-platform
   docker compose up -d --build
   ```

3. 检查状态：

   ```bash
   docker compose ps
   ```

   正常情况下有 7 行（traefik、socket-proxy、postgres、core、portal、installer、installer-proxy），STATUS 都是 Up，postgres 那一行带 healthy。

4. 安装模块。模块在各自的仓库里，打包脚本要用 Node.js，第一次先在 Ubuntu 里装上：

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

   然后下载并安装两个模块。`people` 要先装，`family` 依赖它。`npm run install:local` 会在本地构建镜像、打包，再交给安装器安装，最后一行显示“已就绪”就成功了：

   ```bash
   cd ~
   git clone https://github.com/Beane-Big/vibebooth-module-people.git
   git clone https://github.com/Beane-Big/vibebooth-module-family-score.git
   cd ~/vibebooth-module-people && npm run install:local
   cd ~/vibebooth-module-family-score && npm run install:local
   ```

   构建时要从私有的平台仓库下载 SDK，用的是 git 记住的令牌（第 4 步最后的可选设置）；没让 git 记住的话，先运行 `export VIBEBOOTH_GITHUB_TOKEN=<令牌>`。

5. 在浏览器里打开 **http://localhost:8080**，用户名填 `admin`，密码填第 5 步设置的管理员密码。
6. 能看到“人员管理”“家庭优化大师”两个应用并且能点开，就部署成功了。先在“人员管理”里添加家庭成员，家庭优化大师的记分板上就会出现他们。要给家人开账号，在顶部的“用户”页里新建。部署完之后可以把代理软件切回规则模式。

## 代码更新后重新部署

Windows 上的 `C:\Users\<你的用户名>\...\home-platform` 和 Ubuntu 里的 `~/home-platform` 是**两份独立的仓库**。在 Windows 上改了代码，要先推送到 GitHub，再拉到 Ubuntu 里重新构建。

1. 在 Windows（Git Bash 或 PowerShell）里推送：

   ```bash
   cd "C:\Users\<你的用户名>\...\home-platform"
   git push
   ```

2. 在 Ubuntu 里拉取：

   ```bash
   cd ~/home-platform
   git pull
   ```

3. 看改的是哪部分：
   - **改了平台本体**（`core/`、`portal/`、`installer/`、`packages/`、`docker-compose.yml`）：运行 `docker compose up -d --build`。只重建平台本体，模块不受影响。
   - **改了某个模块**：模块在自己的仓库里，同样先推送、再在 Ubuntu 里 `cd ~/vibebooth-module-<名字>` 并 `git pull`。确认 `module.yaml` 的 `version` 已经改大，再运行 `npm run install:local`，只升级这一个模块，期间它会中断几秒。也可以运行 `npm run pack`，把 `dist/` 里生成的 zip 在门户“应用管理”页上传。

- 仓库已经从 home-platform 改名为 vibebooth，旧地址会自动跳转到新地址。想换成新地址，就在 Windows 和 Ubuntu 的仓库里各运行一次 `git remote set-url origin https://github.com/Beane-Big/vibebooth.git`。本地文件夹名不用改。
- `git pull` 要求输入时，用户名填 `Beane-Big`，密码填第 4 步的只读令牌。
- 代理保持 **TUN + 全局** 模式，因为新代码可能要下载新的依赖。
- 完成后运行 `docker compose ps` 和 `scripts/module list`，确认平台本体都是 Up、模块都是 `"healthy": true`。

## 从旧版本迁移（只做一次）

旧版本里模块写在根目录 `docker-compose.yml` 的 `include` 里，和平台本体是同一个 Compose 项目；新版本里每个模块由安装器单独安装。人员和分数存在卷里，卷名会从 `home-platform_people-data` 变成 `mod-people_people-data`，所以要拷一次数据。登录账号在 postgres 里，不受影响。

```bash
cd ~/home-platform
git pull
# 1. 重建平台本体，并删掉旧的模块容器（--remove-orphans），旧的数据卷还在
docker compose up -d --build --remove-orphans
# 2. 把人员管理和家庭优化大师的数据拷到新卷，旧卷保留不删
scripts/migrate-volumes
```

3. 按“第 6 步”的第 4 条安装模块。

完成后打开门户，确认人员和分数都还在。确认无误后，旧卷可以用 `docker volume rm home-platform_people-data home-platform_family-data` 删除，不删也不影响使用。这次迁移会重启整个平台，之后安装、升级、卸载模块就都不用重启了。

---

## 常用命令

以下命令都在 `~/home-platform` 里运行：

| 想做什么 | 命令 |
| --- | --- |
| 查看平台本体状态 | `docker compose ps` |
| 查看已安装的模块 | `scripts/module list` |
| 查看平台核心的日志（Ctrl+C 退出） | `docker compose logs -f core` |
| 查看某个模块的日志 | `docker logs -f mod-family-family-backend-1` |
| 停止平台本体（数据保留，模块容器不受影响） | `docker compose down` |
| 再次启动，或改了平台本体后重新构建 | `docker compose up -d --build` |
| 安装或升级一个模块 | 在模块仓库里运行 `npm run install:local`；已有模块包时运行 `scripts/module install <模块包.zip>` |
| 卸载一个模块（数据保留；加 `--purge` 连数据一起删） | `scripts/module uninstall <id>` |
| 拉取仓库最新代码 | `git pull` |
| 推倒重来（**删除平台的所有数据和账号，无法恢复**；模块要先逐个 `uninstall --purge`） | `docker compose down -v` |

## 常见问题

| 看到的现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `dial tcp ...:443: i/o timeout` | 连不上 Docker Hub | 按第 3 步打开代理的 TUN 模式 |
| `failed to fetch anonymous token ... EOF` | 代理在下载中途断开 | 代理切到全局模式，然后按第 6 步逐个 `docker pull` |
| `Password authentication is not supported` | GitHub 不接受登录密码 | 按第 4 步生成令牌，把令牌当密码用 |
| `no configuration file provided: not found` | 不在项目文件夹里 | 先运行 `cd ~/home-platform` |
| `permission denied ... docker.sock` | 第 2 步给的权限还没生效 | 关掉 Ubuntu 窗口重新打开；还不行就在 PowerShell 里运行 `wsl --shutdown` |
| `请在 .env 中设置 POSTGRES_PASSWORD` | 没有 `.env` 文件 | 做一遍第 5 步 |
| `port is already allocated` | 8080 端口被其他程序占用 | 在 `.env` 里把 `PUBLIC_PORT` 改成 8081，重新运行 `up -d`，然后访问 `localhost:8081` |
| `core` 一直显示 Restarting | 看日志才能确定，常见原因是管理员密码不足 8 位 | 运行 `docker compose logs core` 查看原因 |
| `找不到安装器镜像` 或 `平台没有在运行` | 安装模块之前平台本体没有起来 | 先运行 `docker compose up -d --build` |
| 安装模块时 `没有通过健康检查` | 模块后端启动失败 | 看命令输出最后几十行的模块日志；新装的模块会自动删掉，升级会自动恢复旧版本 |
| 安装模块时 `依赖模块 people，请先安装它` | `family` 要调用人员管理 | 先在 `~/vibebooth-module-people` 里运行 `npm run install:local` |
| 下载后端依赖时 `github.com/Beane-Big/vibebooth/packages/sdk-go` 报 `not found` 或要求输入用户名 | 令牌没有 `vibebooth` 仓库的权限，或者 git 没记住令牌 | 按第 4 步检查令牌勾选的仓库，或者先 `export VIBEBOOTH_GITHUB_TOKEN=<令牌>` 再运行 |
| `docker compose down` 时提示 `Network platform Resource is still in use` | 模块容器还接在 `platform` 网络上 | 正常现象，不用处理；下次 `up` 会继续用这个网络 |
| `scripts/module: Permission denied` | Windows 上编辑过，脚本丢了可执行权限 | 用 `bash scripts/module ...` 运行 |
| 页面能打开但登录失败 | 账号在第一次启动时已经创建，后来改的密码没有生效 | 用第一次设置的密码登录；忘了就用 `down -v` 推倒重来 |
| 装 WSL 时报错 0x80370102 | BIOS 里关闭了虚拟化 | 进 BIOS 打开 Intel VT-x 或 AMD-V |

## 在家里让家人用（可选，只在家里的电脑上做）

1. 在路由器里给这台电脑固定一个局域网 IP。
2. 在 Windows 防火墙里为 8080 端口添加入站规则，只允许“专用”网络。
3. 家人的设备连同一个 Wi-Fi，然后访问 `http://<电脑的局域网IP>:8080`。

> WSL 默认的网络模式下，局域网里的其他设备可能访问不到 WSL 里的端口，这一点还没有验证过。如果访问不了，记下现象再排查。
>
> 不要在路由器上给 8080 做端口转发，平台目前不应该暴露到公网。
