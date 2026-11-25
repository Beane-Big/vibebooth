#!/usr/bin/env bash
# Vibebooth 一键安装与升级脚本（兼容 Linux / 云服务器 / NAS / WSL Ubuntu / macOS）
#
# 支持两种运行方式：
#   1. 在已下载的仓库目录内运行：bash scripts/install.sh
#   2. 无需提前下载代码，直接一条命令安装：
#      curl -fsSL https://raw.githubusercontent.com/Beane-Big/vibebooth/main/scripts/install.sh | bash
#
# 脚本会自动完成：
#   1. 若尚未下载仓库，自动拉取代码到 ~/vibebooth（支持无 git 时回退压缩包下载）
#   2. 若尚未安装或未启动 Docker，自动安装/启动 Docker（Linux 自动装 Docker Engine 并按需配国内镜像加速；macOS 通过 Homebrew 安装并拉起 Docker Desktop / OrbStack）
#   3. 首次运行自动生成 .env 与随机强密码
#   4. 自动探测网络环境：若无法直连官方源，自动配置国内 Go / npm 镜像源（无需手工加 --cn）
#   5. 优先拉取预构建镜像免编译启动；若预构建镜像暂不可用或拉取失败，自动降级为本机源码构建
#
# 可选参数（也支持环境变量 VIBEBOOTH_FROM_SOURCE / VIBEBOOTH_CN / VIBEBOOTH_PORT / VIBEBOOTH_DIR）：
#   --from-source      强制从当前源码构建
#   --cn               强制配置国内加速源（Docker / Go / npm）
#   --port=8080        指定对外访问端口
#   --dir=<路径>       指定安装目录（仅在线一键安装时生效，默认 ~/vibebooth）
#   --no-auto-docker   未安装 Docker 时仅提示，不自动安装

set -euo pipefail

FROM_SOURCE="${VIBEBOOTH_FROM_SOURCE:-0}"
FORCE_CN="${VIBEBOOTH_CN:-0}"
PORT="${VIBEBOOTH_PORT:-}"
TARGET_DIR="${VIBEBOOTH_DIR:-$HOME/vibebooth}"
AUTO_DOCKER=1
REPO_URL="https://github.com/Beane-Big/vibebooth.git"
TARBALL_URL="https://codeload.github.com/Beane-Big/vibebooth/tar.gz/refs/heads/main"

for arg in "$@"; do
  case "$arg" in
    --from-source) FROM_SOURCE=1 ;;
    --cn) FORCE_CN=1 ;;
    --port=*) PORT="${arg#*=}" ;;
    --dir=*) TARGET_DIR="${arg#*=}" ;;
    --no-auto-docker) AUTO_DOCKER=0 ;;
    -h|--help)
      echo "用法: bash scripts/install.sh [--from-source] [--cn] [--port=8080] [--dir=~/vibebooth] [--no-auto-docker]"
      exit 0
      ;;
  esac
done

OS_NAME="$(uname -s)"
IS_WSL=0
if [ "$OS_NAME" = "Linux" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  IS_WSL=1
fi

# macOS 常见 Docker CLI 路径
if [ "$OS_NAME" = "Darwin" ]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "需要管理员权限执行：$*"
    echo "请使用 root 用户或安装 sudo 后重试。"
    exit 1
  fi
}

can_reach() {
  command -v curl >/dev/null 2>&1 && curl -fsSL --connect-timeout 3 -m 5 -o /dev/null "$1" 2>/dev/null
}

can_reach_registry() {
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  local code
  code="$(curl -s --connect-timeout 3 -m 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo "000")"
  case "$code" in
    200|301|302|401|403) return 0 ;;
    *) return 1 ;;
  esac
}

is_cn_network() {
  if [ "$FORCE_CN" -eq 1 ]; then
    return 0
  fi
  if ! can_reach_registry "https://registry-1.docker.io/v2/"; then
    return 0
  fi
  if ! can_reach "https://proxy.golang.org" && can_reach "https://goproxy.cn"; then
    return 0
  fi
  return 1
}

# 1. 定位或自动下载 Vibebooth 仓库目录
ROOT_DIR=""
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
  CANDIDATE_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
  if [ -f "$CANDIDATE_DIR/docker-compose.yml" ] && [ -f "$CANDIDATE_DIR/.env.example" ]; then
    ROOT_DIR="$CANDIDATE_DIR"
  fi
fi

if [ -z "$ROOT_DIR" ] && [ -f "$PWD/docker-compose.yml" ] && [ -f "$PWD/.env.example" ]; then
  ROOT_DIR="$PWD"
fi

if [ -z "$ROOT_DIR" ]; then
  ROOT_DIR="$TARGET_DIR"
  if [ ! -f "$ROOT_DIR/docker-compose.yml" ]; then
    echo "正在获取 Vibebooth 到 ${ROOT_DIR} ..."
    mkdir -p "$(dirname "$ROOT_DIR")"
    DOWNLOADED=0
    if command -v git >/dev/null 2>&1; then
      if git clone --depth 1 "$REPO_URL" "$ROOT_DIR"; then
        DOWNLOADED=1
      else
        rm -rf "$ROOT_DIR"
      fi
    fi
    if [ "$DOWNLOADED" -eq 0 ]; then
      if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
        echo "下载代码失败：请先安装 git 或 curl + tar 后重试。"
        exit 1
      fi
      echo "尝试通过压缩包下载 Vibebooth..."
      mkdir -p "$ROOT_DIR"
      curl -fL --retry 3 -m 120 "$TARBALL_URL" | tar xz -C "$ROOT_DIR" --strip-components=1
    fi
  else
    echo "检测到已有 Vibebooth 目录：${ROOT_DIR}"
  fi
fi

cd "$ROOT_DIR"

# 2. 检查并自动安装 / 启动 Docker
DOCKER_CMD=(docker)
ADDED_DOCKER_GROUP=0

configure_linux_docker_mirror() {
  if ! is_cn_network; then
    return 0
  fi
  # 如果用户已经配置过 registry-mirrors，则尊重现有配置
  if [ -f /etc/docker/daemon.json ] && grep -q "registry-mirrors" /etc/docker/daemon.json 2>/dev/null; then
    return 0
  fi
  # 若已存在非空自定义 daemon.json，避免覆盖用户原有配置
  if [ -f /etc/docker/daemon.json ]; then
    local trimmed
    trimmed="$(tr -d ' \t\r\n' </etc/docker/daemon.json 2>/dev/null || true)"
    if [ -n "$trimmed" ] && [ "$trimmed" != "{}" ]; then
      return 0
    fi
  fi

  local candidates=(
    "https://mirror.ccs.tencentyun.com"
    "https://docker.m.daocloud.io"
    "https://docker.1ms.run"
  )
  local mirrors=()
  local m
  for m in "${candidates[@]}"; do
    if can_reach_registry "${m}/v2/"; then
      mirrors+=("\"${m}\"")
    fi
  done
  if [ "${#mirrors[@]}" -eq 0 ]; then
    return 0
  fi

  local joined
  joined="$(IFS=,; echo "${mirrors[*]}")"
  echo "检测到国内网络，自动配置 Docker 镜像加速..."
  run_privileged mkdir -p /etc/docker
  printf '{\n  "registry-mirrors": [%s]\n}\n' "$joined" | run_privileged tee /etc/docker/daemon.json >/dev/null
  if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
    run_privileged systemctl restart docker || true
  elif command -v service >/dev/null 2>&1; then
    run_privileged service docker restart || true
  fi
}

install_docker_linux() {
  echo "未检测到 Docker，正在自动安装 Docker（Linux）..."
  local installed=0
  if command -v curl >/dev/null 2>&1; then
    if is_cn_network; then
      echo "检测到国内网络，使用国内镜像源安装 Docker..."
      if curl -fsSL --connect-timeout 10 https://get.docker.com | run_privileged sh -s -- --mirror Aliyun; then
        installed=1
      fi
    else
      if curl -fsSL --connect-timeout 10 https://get.docker.com | run_privileged sh; then
        installed=1
      fi
    fi
  fi

  if [ "$installed" -eq 0 ]; then
    if command -v apt-get >/dev/null 2>&1; then
      echo "尝试通过系统软件源安装 Docker..."
      run_privileged apt-get update
      run_privileged apt-get install -y docker.io docker-compose-v2 || run_privileged apt-get install -y docker.io docker-compose-plugin
      installed=1
    elif command -v dnf >/dev/null 2>&1; then
      run_privileged dnf install -y docker docker-compose-plugin || true
      installed=1
    fi
  fi

  if [ "$installed" -eq 0 ] || ! command -v docker >/dev/null 2>&1; then
    echo "自动安装 Docker 失败，请手动安装 Docker 后重新运行本脚本："
    echo "  curl -fsSL https://get.docker.com | sudo sh"
    exit 1
  fi

  if [ "$(id -u)" -ne 0 ] && [ -n "${USER:-}" ]; then
    if run_privileged usermod -aG docker "$USER" 2>/dev/null; then
      ADDED_DOCKER_GROUP=1
    fi
  fi
}

start_docker_linux() {
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
    return 0
  fi
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER_CMD=(sudo docker)
    return 0
  fi

  echo "正在启动 Docker 服务..."
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    run_privileged systemctl enable --now docker >/dev/null 2>&1 || run_privileged systemctl start docker >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    run_privileged service docker start >/dev/null 2>&1 || true
  fi

  local i
  for i in $(seq 1 20); do
    if docker info >/dev/null 2>&1; then
      DOCKER_CMD=(docker)
      return 0
    fi
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
      DOCKER_CMD=(sudo docker)
      return 0
    fi
    sleep 1
  done

  echo "Docker 服务未就绪。请检查 Docker 状态后重试（例如运行 sudo systemctl status docker）。"
  if [ "$IS_WSL" -eq 1 ]; then
    echo "WSL 提示：如在 Windows 上安装了 Docker Desktop，请确认已在设置中开启 WSL Integration。"
  fi
  exit 1
}

ensure_docker_macos() {
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$AUTO_DOCKER" -eq 0 ]; then
      echo "未检测到 Docker。请安装 Docker Desktop（https://www.docker.com/products/docker-desktop/）或 OrbStack（https://orbstack.dev/）后重试。"
      exit 1
    fi
    if command -v brew >/dev/null 2>&1; then
      echo "未检测到 Docker，正在通过 Homebrew 自动安装 Docker Desktop..."
      brew install --cask docker
      export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
    else
      echo "未检测到 Docker（也未检测到 Homebrew，无法自动安装）。"
      echo "请先安装 Docker Desktop 后重新运行本命令："
      echo "  下载地址：https://www.docker.com/products/docker-desktop/"
      echo "  （或更轻量的 OrbStack：https://orbstack.dev/）"
      exit 1
    fi
  fi

  if ! docker info >/dev/null 2>&1; then
    if [ -d "/Applications/OrbStack.app" ]; then
      echo "正在启动 OrbStack..."
      open -a OrbStack || true
    elif [ -d "/Applications/Docker.app" ]; then
      echo "正在启动 Docker Desktop（首次打开可能需要在弹窗中同意协议）..."
      open -a Docker || true
    else
      echo "Docker 引擎尚未运行，请先打开 Docker Desktop 或 OrbStack 后重试。"
      exit 1
    fi

    echo -n "等待 Docker 引擎就绪"
    local i
    for i in $(seq 1 60); do
      if docker info >/dev/null 2>&1; then
        echo " 完成！"
        break
      fi
      echo -n "."
      sleep 2
    done
    echo ""
    if ! docker info >/dev/null 2>&1; then
      echo "等待 Docker 启动超时。请确认 Docker Desktop / OrbStack 已完成初始化后再次运行本命令。"
      exit 1
    fi
  fi

  DOCKER_CMD=(docker)
}

if [ "$OS_NAME" = "Darwin" ]; then
  ensure_docker_macos
elif [ "$OS_NAME" = "Linux" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$AUTO_DOCKER" -eq 0 ]; then
      echo "未检测到 Docker。请先运行以下命令安装 Docker 后重试："
      echo "  curl -fsSL https://get.docker.com | sudo sh"
      exit 1
    fi
    install_docker_linux
  fi
  configure_linux_docker_mirror
  start_docker_linux
else
  echo "暂不支持在 ${OS_NAME} 下直接运行 install.sh。"
  echo "如使用 Windows，请改用 PowerShell 运行：irm https://raw.githubusercontent.com/Beane-Big/vibebooth/main/scripts/install.ps1 | iex"
  exit 1
fi

if ! "${DOCKER_CMD[@]}" compose version >/dev/null 2>&1; then
  if [ "$OS_NAME" = "Linux" ] && [ "$AUTO_DOCKER" -eq 1 ] && command -v apt-get >/dev/null 2>&1; then
    echo "未检测到 docker compose 插件，正在自动安装..."
    run_privileged apt-get update
    run_privileged apt-get install -y docker-compose-v2 || run_privileged apt-get install -y docker-compose-plugin
  fi
fi

if ! "${DOCKER_CMD[@]}" compose version >/dev/null 2>&1; then
  echo "未检测到 docker compose v2 插件，请升级 Docker 到较新版本后重试。"
  exit 1
fi

# 3. 生成 .env 并配置国内加速源
rand_str() {
  if command -v openssl >/dev/null 2>&1; then
    LC_ALL=C openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c "$1"
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"
  fi
}

get_env_val() {
  local key="$1"
  grep -E "^${key}=" .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '\r' || true
}

set_env_val() {
  local key="$1"
  local val="$2"
  if grep -qE "^${key}=" .env 2>/dev/null; then
    sed -i.bak "s#^${key}=.*#${key}=${val}#" .env
    rm -f .env.bak
  else
    printf '\n%s=%s\n' "$key" "$val" >> .env
  fi
}

NEW_ENV=0
INIT_ADMIN_PASS=""

if [ ! -f .env ]; then
  NEW_ENV=1
  cp .env.example .env
  PG_PASS="$(rand_str 24)"
  INIT_ADMIN_PASS="$(rand_str 14)"
  set_env_val "POSTGRES_PASSWORD" "$PG_PASS"
  set_env_val "ADMIN_PASSWORD" "$INIT_ADMIN_PASS"
  chmod 600 .env
  echo "已自动生成 .env 配置文件。"
fi

if [ -n "$PORT" ]; then
  set_env_val "PUBLIC_PORT" "$PORT"
fi

# 无论 .env 是新建还是已存在，都确保国内网络环境下自动配置可用的镜像源。
CUR_GOPROXY="$(get_env_val GOPROXY)"
CUR_NPM="$(get_env_val NPM_REGISTRY)"

if [ "$FORCE_CN" -eq 1 ]; then
  set_env_val "GOPROXY" "https://goproxy.cn,direct"
  set_env_val "NPM_REGISTRY" "https://registry.npmmirror.com"
  echo "已配置国内加速源（GOPROXY=https://goproxy.cn,direct，NPM_REGISTRY=https://registry.npmmirror.com）。"
elif [ -z "$CUR_GOPROXY" ] || [ -z "$CUR_NPM" ]; then
  echo "正在检测网络环境..."
  CN_DETECTED=0
  if [ -z "$CUR_GOPROXY" ]; then
    if ! can_reach "https://proxy.golang.org" && can_reach "https://goproxy.cn"; then
      set_env_val "GOPROXY" "https://goproxy.cn,direct"
      CN_DETECTED=1
    fi
  fi
  if [ -z "$CUR_NPM" ]; then
    if [ "$CN_DETECTED" -eq 1 ] || (! can_reach "https://registry.npmjs.org/" && can_reach "https://registry.npmmirror.com"); then
      if can_reach "https://registry.npmmirror.com"; then
        set_env_val "NPM_REGISTRY" "https://registry.npmmirror.com"
        CN_DETECTED=1
      fi
    fi
  fi
  if [ "$CN_DETECTED" -eq 1 ]; then
    echo "检测到国内网络环境，已自动配置加速源：GOPROXY=$(get_env_val GOPROXY)，NPM_REGISTRY=$(get_env_val NPM_REGISTRY)"
  fi
fi

# 同步导出给 docker compose，避免宿主机存在空的同名环境变量覆盖 .env。
FINAL_GOPROXY="$(get_env_val GOPROXY)"
FINAL_NPM="$(get_env_val NPM_REGISTRY)"
[ -n "$FINAL_GOPROXY" ] && export GOPROXY="$FINAL_GOPROXY"
[ -n "$FINAL_NPM" ] && export NPM_REGISTRY="$FINAL_NPM"

PUBLIC_PORT_VAL="$(get_env_val PUBLIC_PORT)"
PUBLIC_PORT_VAL="${PUBLIC_PORT_VAL:-8080}"

# 4. 检测冲突实例并启动 Vibebooth
CONFLICT_PROJECTS="$("${DOCKER_CMD[@]}" ps --filter "network=platform" --filter "label=com.docker.compose.service=portal" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -vx 'home-platform' | sort -u || true)"
if [ -n "$CONFLICT_PROJECTS" ]; then
  echo "警告：检测到其他同名平台实例正在运行，可能造成路由冲突或资源 404："
  for p in $CONFLICT_PROJECTS; do
    echo "  -> 可执行停止：docker compose -p ${p} down"
  done
  echo ""
fi

start_from_source() {
  echo "正在从源码构建并启动 Vibebooth（首次构建约需几分钟）..."
  "${DOCKER_CMD[@]}" compose up -d --build
}

if [ "$FROM_SOURCE" -eq 1 ]; then
  start_from_source
else
  echo "正在拉取预构建镜像..."
  if "${DOCKER_CMD[@]}" compose -f docker-compose.prebuilt.yml pull; then
    "${DOCKER_CMD[@]}" compose -f docker-compose.prebuilt.yml up -d
  else
    echo "预构建镜像暂不可用，自动切换为本机源码构建..."
    start_from_source
  fi
fi

# 5. 输出访问地址与初始账号信息
LAN_IP=""
if [ "$OS_NAME" = "Darwin" ]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
elif command -v hostname >/dev/null 2>&1; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi

echo ""
echo "========================================"
echo "  Vibebooth 已启动"
echo "  安装目录：${ROOT_DIR}"
echo "  本机访问：http://localhost:${PUBLIC_PORT_VAL}"
if [ -n "$LAN_IP" ] && [ "$LAN_IP" != "127.0.0.1" ]; then
  echo "  局域网访问：http://${LAN_IP}:${PUBLIC_PORT_VAL}"
fi
if [ "$NEW_ENV" -eq 1 ]; then
  echo "  初始账号：admin"
  echo "  初始密码：${INIT_ADMIN_PASS}"
  echo "  （请妥善保存，首次登录后可在“联系人 → 我”中修改密码）"
fi
if [ "$ADDED_DOCKER_GROUP" -eq 1 ]; then
  echo "  提示：已将当前用户加入 docker 组，后续手动执行 docker 命令前请重新打开终端。"
fi
echo "========================================"
