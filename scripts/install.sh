#!/usr/bin/env bash
# Vibebooth 一键安装与升级脚本（适用于 Linux / 云服务器 / NAS / WSL Ubuntu）
# 用法：
#   bash scripts/install.sh                 # 使用预构建镜像快速启动（默认）
#   bash scripts/install.sh --from-source   # 从当前源码构建并启动
#   bash scripts/install.sh --cn            # 自动写入国内 Go/npm 镜像源

set -euo pipefail

FROM_SOURCE=0
USE_CN=0
PORT=""

for arg in "$@"; do
  case "$arg" in
    --from-source) FROM_SOURCE=1 ;;
    --cn) USE_CN=1 ;;
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

NEW_ENV=0
INIT_ADMIN_PASS=""

if [ ! -f .env ]; then
  NEW_ENV=1
  cp .env.example .env
  PG_PASS="$(rand_str 24)"
  INIT_ADMIN_PASS="$(rand_str 14)"
  sed -i.bak "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${PG_PASS}/" .env
  sed -i.bak "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${INIT_ADMIN_PASS}/" .env
  if [ -n "$PORT" ]; then
    sed -i.bak "s/^PUBLIC_PORT=.*/PUBLIC_PORT=${PORT}/" .env
  fi
  if [ "$USE_CN" -eq 1 ]; then
    sed -i.bak "s#^GOPROXY=.*#GOPROXY=https://goproxy.cn,direct#" .env
    sed -i.bak "s#^NPM_REGISTRY=.*#NPM_REGISTRY=https://registry.npmmirror.com#" .env
  fi
  rm -f .env.bak
  chmod 600 .env
  echo "已自动生成 .env 配置文件。"
fi

PUBLIC_PORT_VAL="$(grep -E '^PUBLIC_PORT=' .env | head -n1 | cut -d= -f2 || true)"
PUBLIC_PORT_VAL="${PUBLIC_PORT_VAL:-8080}"

if [ "$FROM_SOURCE" -eq 1 ]; then
  echo "正在从源码构建并启动 Vibebooth..."
  docker compose up -d --build
else
  echo "正在拉取预构建镜像并启动 Vibebooth..."
  docker compose -f docker-compose.prebuilt.yml pull
  docker compose -f docker-compose.prebuilt.yml up -d
fi

echo ""
echo "========================================"
echo "  Vibebooth 已启动"
echo "  访问地址：http://localhost:${PUBLIC_PORT_VAL}"
if [ "$NEW_ENV" -eq 1 ]; then
  echo "  初始账号：admin"
  echo "  初始密码：${INIT_ADMIN_PASS}"
  echo "  （请妥善保存，首次登录后可在“联系人 → 我”中修改密码）"
fi
echo "========================================"
