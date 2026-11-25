#!/usr/bin/env bash
# Vibebooth 一键备份与恢复脚本（包含平台数据库、核心数据、已安装模块清单及全部模块数据卷）
# 用法：
#   bash scripts/backup.sh export [输出路径.tar.gz]
#   bash scripts/backup.sh restore <备份文件.tar.gz>

set -euo pipefail

CMD="${1:-}"
TARGET="${2:-}"

if [ "$CMD" != "export" ] && [ "$CMD" != "restore" ]; then
  echo "用法："
  echo "  bash scripts/backup.sh export [backup.tar.gz]"
  echo "  bash scripts/backup.sh restore <backup.tar.gz>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

export_backup() {
  local out="${TARGET:-$ROOT_DIR/vibebooth-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"
  mkdir -p "$WORK_DIR/volumes"

  echo "1/3 导出平台 PostgreSQL 数据库..."
  docker compose exec -T postgres pg_dump -U platform -d platform --clean --if-exists > "$WORK_DIR/platform.sql"

  echo "2/3 打包平台与已安装模块的数据卷..."
  local volumes=()
  for v in home-platform_core-data home-platform_modules-data home-platform_builder-data; do
    if docker volume inspect "$v" >/dev/null 2>&1; then
      volumes+=("$v")
    fi
  done
  while IFS= read -r v; do
    [ -n "$v" ] && volumes+=("$v")
  done < <(docker volume ls --format '{{.Name}}' | grep -E '^mod-' || true)

  for v in "${volumes[@]}"; do
    echo "    -> 备份卷 $v"
    docker run --rm -v "${v}:/src:ro" -v "$WORK_DIR/volumes:/dst" alpine:3.22 \
      tar czf "/dst/${v}.tar.gz" -C /src .
  done

  echo "3/3 生成归档文件..."
  tar czf "$out" -C "$WORK_DIR" .
  echo "备份完成：$out"
}

restore_backup() {
  if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
    echo "请指定有效的备份文件：bash scripts/backup.sh restore <backup.tar.gz>"
    exit 1
  fi

  echo "正在解压备份：$TARGET"
  tar xzf "$TARGET" -C "$WORK_DIR"

  if [ -f "$WORK_DIR/platform.sql" ]; then
    echo "1/2 恢复平台 PostgreSQL 数据库..."
    docker compose exec -T postgres psql -U platform -d platform < "$WORK_DIR/platform.sql" >/dev/null
  fi

  echo "2/2 恢复数据卷..."
  for archive in "$WORK_DIR"/volumes/*.tar.gz; do
    [ -f "$archive" ] || continue
    local v
    v="$(basename "$archive" .tar.gz)"
    echo "    -> 恢复卷 $v"
    docker volume create "$v" >/dev/null
    docker run --rm -v "${v}:/dst" -v "$WORK_DIR/volumes:/src:ro" alpine:3.22 \
      sh -c "rm -rf /dst/* /dst/.[!.]* /dst/..?* 2>/dev/null || true; tar xzf '/src/${v}.tar.gz' -C /dst"
  done

  echo "恢复完成。建议执行 docker compose restart core builder installer 使数据立即生效。"
}

if [ "$CMD" = "export" ]; then
  export_backup
else
  restore_backup
fi
