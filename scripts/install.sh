#!/usr/bin/env bash
# Vibebooth 一键安装与升级脚本（适用于 Linux / 云服务器 / NAS / WSL Ubuntu）
# 直接运行即可，脚本会自动：
#   1. 生成 .env 与随机强密码（首次运行时）
#   2. 探测网络环境：若无法直连官方源，自动配置国内 Go / npm 镜像源（无需手工加 --cn）
#   3. 优先拉取预构建镜像免编译启动；若预构建镜像暂不可用或拉取失败，自动降级为本机源码构建
#
# 可选参数：
#   --from-source   强制从当前源码构建
#   --cn            强制写入国内 Go / npm 镜像源
#   --port=8080     指定对外访问端口

set -euo pipefail

FROM_SOURCE=0
FORCE_CN=0
PORT=""

for arg in "$@"; do
  case "$arg" in
    --from-source) FROM_SOURCE=1 ;;
    --cn) FORCE_CN=1 ;;
    --port=*) PORT="${arg#*=}" ;;
    -h|--help)
      echo "用法: bash scripts/install.sh [--from-source] [--cn] [--port=8080]"
      exit 0
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "未检测到 Docker。请先运行以下命令安装 Docker 后重试："
  echo "  curl -fsSL https://get.docker.com | sudo sh"
  echo "  sudo usermod -aG docker \$USER"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "未检测到 docker compose 插件，请升级 Docker 到较新版本。"
  exit 1
fi

rand_str() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c "$1"
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

can_reach() {
  command -v curl >/dev/null 2>&1 && curl -fsSL -m 4 -o /dev/null "$1" 2>/dev/null
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

# 检查是否有其他 Compose 项目名下的旧平台实例挂在 platform 网络，防止 Traefik 路由轮询冲突。
CONFLICT_PROJECTS="$(docker ps --filter "network=platform" --filter "label=com.docker.compose.service=portal" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -vx 'home-platform' | sort -u || true)"
if [ -n "$CONFLICT_PROJECTS" ]; then
  echo "警告：检测到其他同名平台实例正在运行，可能造成路由冲突或资源 404："
  for p in $CONFLICT_PROJECTS; do
    echo "  -> 可执行停止：docker compose -p ${p} down"
  done
  echo ""
fi

start_from_source() {
  echo "正在从源码构建并启动 Vibebooth（首次构建约需几分钟）..."
  docker compose up -d --build
}

if [ "$FROM_SOURCE" -eq 1 ]; then
  start_from_source
else
  echo "正在拉取预构建镜像..."
  if docker compose -f docker-compose.prebuilt.yml pull; then
    docker compose -f docker-compose.prebuilt.yml up -d
  else
    echo "预构建镜像暂不可用，自动切换为本机源码构建..."
    start_from_source
  fi
fi

LAN_IP=""
if command -v hostname >/dev/null 2>&1; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi

echo ""
echo "========================================"
echo "  Vibebooth 已启动"
echo "  本机访问：http://localhost:${PUBLIC_PORT_VAL}"
if [ -n "$LAN_IP" ] && [ "$LAN_IP" != "127.0.0.1" ]; then
  echo "  局域网/宿主机访问：http://${LAN_IP}:${PUBLIC_PORT_VAL}"
fi
if [ "$NEW_ENV" -eq 1 ]; then
  echo "  初始账号：admin"
  echo "  初始密码：${INIT_ADMIN_PASS}"
  echo "  （请妥善保存，首次登录后可在“联系人 → 我”中修改密码）"
fi
echo "========================================"
