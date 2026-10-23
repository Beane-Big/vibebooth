# Vibebooth 部署文档（国内云服务器）

在国内的云服务器（例如腾讯云轻量应用服务器，Ubuntu 24.04）上部署平台。和在自己电脑上部署（见 [DEPLOY.md](DEPLOY.md)）相比，主要差别是：服务器连不上 Docker Hub 和 Go 官方代理，要换成国内镜像；平台直接暴露在公网上，要注意安全。

整个流程分 5 步：

1. 检查服务器的网络
2. 配 Docker 镜像加速，下载代码
3. 填配置文件 `.env`，启动平台
4. 开放端口，登录
5. 装构建器，再用它安装其他模块

**约定：** 下面的命令都在服务器的 SSH 窗口里运行，用户是 `ubuntu`。

> **安全提醒：** 平台目前只有 HTTP。用 `http://<公网IP>:8080` 访问时，密码在网络上是明文传输的，只适合过渡使用：管理员用随机生成的强密码，防火墙只开这一个端口。要长期使用，就准备一个域名（国内服务器要先做 ICP 备案），改用 HTTPS。

---

## 第 1 步：检查服务器的网络

```bash
cat /etc/os-release | head -2; nproc; free -h; df -h /
docker --version 2>&1; git --version
curl -s -m 5 -o /dev/null -w "dockerhub %{http_code}\n" https://registry-1.docker.io/v2/
curl -s -m 5 -o /dev/null -w "goproxy %{http_code}\n" https://proxy.golang.org
curl -s -m 5 -o /dev/null -w "npm %{http_code}\n" https://registry.npmjs.org/
curl -s -m 5 -o /dev/null -w "github %{http_code}\n" https://github.com
```

在上海的腾讯云上实测：`dockerhub` 和 `goproxy` 是 `000`（连不上），`npm` 和 `github` 是 `200`。2 核 4G 内存够用。没装 Docker 的话，先运行 `curl -fsSL https://get.docker.com | sudo sh`。

## 第 2 步：配 Docker 镜像加速，下载代码

腾讯云服务器可以用腾讯云内网的 Docker Hub 镜像：

```bash
echo '{"registry-mirrors":["https://mirror.ccs.tencentyun.com"]}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
sudo usermod -aG docker $USER
```

运行完**退出 SSH 再重新登录**，让最后一条给的权限生效。然后检查镜像能不能拉下来，再下载代码：

```bash
docker pull alpine:3.22
git clone --depth 1 https://github.com/Beane-Big/vibebooth.git ~/vibebooth
```

`--depth 1` 只下载最新的一版代码，不下载提交历史，不容易卡住；以后照样能 `git pull`。还是卡住的话，按 Ctrl+C 停掉，改成下载压缩包：

```bash
rm -rf ~/vibebooth && mkdir ~/vibebooth
curl -fL --retry 3 -m 120 https://codeload.github.com/Beane-Big/vibebooth/tar.gz/refs/heads/main | tar xz -C ~/vibebooth --strip-components=1
```

用压缩包的话，以后更新要重新下载一次，不能 `git pull`。

## 第 3 步：填配置文件 .env，启动平台

```bash
cd ~/vibebooth
cp .env.example .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -dc A-Za-z0-9)/" .env
sed -i "s#^GOPROXY=.*#GOPROXY=https://goproxy.cn,direct#; s#^NPM_REGISTRY=.*#NPM_REGISTRY=https://registry.npmmirror.com#" .env
grep -E "PASSWORD|GOPROXY|NPM" .env
```

最后一行打印出 4 行，每行等号后面都有值。**ADMIN_PASSWORD 就是网页的登录密码，马上记下来。** 管理员账号只在第一次启动时创建，之后再改 `.env` 不会生效。

```bash
docker compose up -d --build
docker compose ps
```

第一次构建要几分钟。正常情况下有 8 行，STATUS 都是 Up，postgres 那一行带 healthy。

## 第 4 步：开放端口，登录

在云服务器控制台的**防火墙**里加一条规则，放行 TCP 8080。然后在浏览器打开 `http://<公网IP>:8080`，用户名 `admin`，密码是第 3 步记下的 ADMIN_PASSWORD。

## 第 5 步：装构建器，再用它安装其他模块

服务器上没有代理，不要在服务器上运行模块仓库的 `npm run install:local`。先装一个构建器模块，以后的模块都交给它在服务器上构建。

1. **下载构建器的软件包。** 构建器模块（[vibebooth-module-builder](https://github.com/Beane-Big/vibebooth-module-builder)）的 Releases 里有打好的 zip；没有的话，在它仓库的 Actions 页面运行“发布软件包”。
2. **上传安装。** 在门户“应用管理”页上传这个 zip。它声明了 `docker-build` 特权，页面提示时点确认。
3. **设置镜像源。** 在门户“设置”页进入构建器的设置，Go 代理填 `https://goproxy.cn,direct`，npm 镜像源填 `https://registry.npmmirror.com`，然后保存。不设置的话，构建会卡在下载 Go 依赖（日志里能看到 `proxy.golang.org ... i/o timeout`）。
4. **安装其他模块。** 在 GitHub 上打开模块仓库，点 Code → Download ZIP（或者直接下载 `https://github.com/<用户>/<模块仓库>/archive/refs/heads/main.zip`），上传到构建器。构建成功后点“安装到本平台”。有 `requires` 的模块要先装它依赖的模块。

## 代码更新后重新部署

- **平台本体：** `cd ~/vibebooth && git pull && docker compose up -d --build`。只重建平台本体，模块不受影响。
- **模块：** 确认模块的 `module.yaml` 里 `version` 已经改大，再按第 5 步第 4 条重新下载 zip、上传给构建器构建并安装。

## 常见问题

| 看到的现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `docker pull` 时 `i/o timeout` | 没配镜像加速，或者配置没生效 | 检查 `/etc/docker/daemon.json`，运行 `sudo systemctl restart docker` |
| `git clone` 一直没有进展 | 访问 GitHub 的 git 下载不稳定 | 用 `--depth 1` 重试，或者改用第 2 步的压缩包 |
| 构建平台时卡在 `go mod download` | `.env` 里没设置 `GOPROXY` | 按第 3 步补上，重新 `docker compose up -d --build` |
| 构建器的日志里 `proxy.golang.org ... i/o timeout` | 构建器的设置里没填 Go 代理 | 按第 5 步第 3 条设置后重新上传 |
| 浏览器打不开 `http://<公网IP>:8080` | 防火墙没放行 8080 | 按第 4 步在控制台放行 |
| `permission denied ... docker.sock` | 第 2 步给的权限还没生效 | 退出 SSH 重新登录 |

平台本体和模块的其他命令见 [DEPLOY.md](DEPLOY.md) 的“常用命令”。
