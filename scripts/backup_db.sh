#!/usr/bin/env bash
# PostgreSQL 自动备份脚本（P2-8 备份与恢复）
#
# 用法:  bash scripts/backup_db.sh
# 前置: 在项目根目录放置 .env，含以下变量（不硬编码任何密码）:
#        PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
# 说明: 仅做本地 pg_dump + gzip，未含加密与异地传输。
#       生产环境请在此基础上追加 gpg 加密与对象存储上传步骤。
# 保留: 最近的 14 份备份，超出的旧备份自动清理。

set -euo pipefail

# 读取项目根目录的 .env（若存在）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${PGHOST:?请在 .env 设置 PGHOST}"
: "${PGPORT:-5432}"
: "${PGUSER:?请在 .env 设置 PGUSER}"
: "${PGPASSWORD:?请在 .env 设置 PGPASSWORD}"
: "${PGDATABASE:?请在 .env 设置 PGDATABASE}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/${PGDATABASE}_${STAMP}.sql.gz"

echo "备份 $PGDATABASE -> $OUT"
PGPASSWORD="$PGPASSWORD" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  --no-owner --clean --if-exists | gzip > "$OUT"

echo "完成: $OUT ($(du -h "$OUT" | cut -f1))"

# 保留最近 14 份，超出部分自动清理
ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "已清理超出保留周期的旧备份（保留 14 份）"
