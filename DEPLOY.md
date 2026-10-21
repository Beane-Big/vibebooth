# home-platform 部署文档（Windows + WSL）

> 2026-10-21 在公司电脑上实际部署过一遍，这份文档按当时真实走通的路线整理，踩过的坑都写进去了。

整个流程分 6 步，顺利的话 1 小时内能在浏览器里打开 `http://localhost:8080` 并登录：

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
3. Repository access 选 **Only select repositories**，然后选 `home-platform`。
4. 在 Permissions 里把 **Contents** 设为 **Read-only**。
5. 点 Generate token，**马上复制**。离开这个页面后就再也看不到了。

**clone 代码：**

```bash
git clone https://github.com/Beane-Big/home-platform.git ~/home-platform
cd ~/home-platform
```

- Username 填 `Beane-Big`
- Password 填刚才复制的令牌（右键粘贴，屏幕上不会显示），然后回车

> 令牌就相当于密码，不要发给任何人。用完可以在同一个页面删掉。
>
> 代码要放在 `~/home-platform`，不要放在 `/mnt/c/` 下面，那里读写慢，也容易出权限问题。想用 Windows 资源管理器查看这些文件，在项目文件夹里运行 `explorer.exe .` 就行。

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

1. 先把三个现成的镜像逐个下载下来。一次只下一个更稳，哪条失败就重新运行哪条：

   ```bash
   docker pull tecnativa/docker-socket-proxy:v0.4.1
   docker pull traefik:v3.6
   docker pull postgres:17-alpine
   ```

2. 构建并启动。第一次运行要几分钟，屏幕上滚过很多输出是正常的：

   ```bash
   cd ~/home-platform
   docker compose up -d --build
   ```

3. 检查状态：

   ```bash
   docker compose ps
   ```

   正常情况下有 7 行，STATUS 都是 Up，postgres 那一行带 healthy。

4. 在浏览器里打开 **http://localhost:8080**，用户名填 `admin`，密码填第 5 步设置的管理员密码。
5. 能看到“你好”应用并且能点开，就部署成功了。部署完之后可以把代理软件切回规则模式。

---

## 常用命令

以下命令都在 `~/home-platform` 里运行：

| 想做什么 | 命令 |
| --- | --- |
| 查看各服务状态 | `docker compose ps` |
| 查看某个服务的日志（Ctrl+C 退出） | `docker compose logs -f core` |
| 停止（数据保留） | `docker compose down` |
| 再次启动，或改代码后重新构建 | `docker compose up -d --build` |
| 拉取仓库最新代码 | `git pull` |
| 推倒重来（**删除所有数据和账号，无法恢复**） | `docker compose down -v` |

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
| 页面能打开但登录失败 | 账号在第一次启动时已经创建，后来改的密码没有生效 | 用第一次设置的密码登录；忘了就用 `down -v` 推倒重来 |
| 装 WSL 时报错 0x80370102 | BIOS 里关闭了虚拟化 | 进 BIOS 打开 Intel VT-x 或 AMD-V |

## 在家里让家人用（可选，只在家里的电脑上做）

1. 在路由器里给这台电脑固定一个局域网 IP。
2. 在 Windows 防火墙里为 8080 端口添加入站规则，只允许“专用”网络。
3. 家人的设备连同一个 Wi-Fi，然后访问 `http://<电脑的局域网IP>:8080`。

> WSL 默认的网络模式下，局域网里的其他设备可能访问不到 WSL 里的端口，这一点还没有验证过。如果访问不了，记下现象再排查。
>
> 不要在路由器上给 8080 做端口转发，平台目前不应该暴露到公网。
