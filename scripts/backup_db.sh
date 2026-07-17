#!/usr/bin/env bash
# PostgreSQL 自动备份脚本（P2-5 生产闭环）
#
# 用法:  bash scripts/backup_db.sh
# 前置: 在项目根目录放置 .env，含以下变量（不硬编码任何密码）:
#        PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
#        可选 BACKUP_PASSPHRASE：设置后才对备份加密（推荐生产必填）
# 说明:
#   - 本地 pg_dump + gzip 导出
#   - 生成 SHA256 校验文件，便于恢复前核对完整性
#   - 设置了 BACKUP_PASSPHRASE 则额外做 AES256 对称加密并删除明文（生产数据不外泄）
#   - 保留最近 14 份，超出自动清理
#
# 运维要点（P2-5）:
#   - RPO（恢复点目标）：每天 1 份 => 最多丢失约 1 天数据。如需更短，改为每小时并相应调整保留份数。
#   - RTO（恢复时间目标）：恢复 = gpg 解密 -> gunzip -> psql 导入。应定期做恢复演练（见下方 restore_drill 说明）确认可用。
#   - 异地存储：建议把 backups/ 同步到对象存储/另一台机器（如 rclone/rsync），避免单机故障导致备份与数据库同归于尽。
#   - 恢复演练：定期在隔离环境执行下方“恢复演练”步骤，确认备份可还原、密码/校验流程无误。

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

# 完整性校验
sha256sum "$OUT" > "$OUT.sha256"
echo "校验文件: $OUT.sha256 ($(du -h "$OUT" | cut -f1))"

# 加密（设置了 BACKUP_PASSPHRASE 才启用；密码仅来自环境变量，不落盘、不硬编码）
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase "$BACKUP_PASSPHRASE" -o "$OUT.gpg" "$OUT"
  rm -f "$OUT"   # 不保留明文，避免敏感数据以明文形式留存
  echo "已加密: $OUT.gpg"
fi

# 保留最近 14 份（含 .sql.gz / .gpg / .sha256 一并清理），超出部分自动删除
ls -1t "$BACKUP_DIR"/*."${PGDATABASE}"_*.sql.gz* 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/*."${PGDATABASE}"_*.sha256 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "已清理超出保留周期的旧备份（保留 14 份）"

# ===== 恢复演练（手动执行示例，不在定时备份中自动跑） =====
# 解密（若已加密）:
#   gpg --batch --yes --decrypt --passphrase "$BACKUP_PASSPHRASE" backups/<库名>_<时间戳>.sql.gz.gpg > /tmp/restore.sql.gz
# 校验完整性:
#   sha256sum -c backups/<库名>_<时间戳>.sql.gz.sha256
# 导入:
#   gunzip -c /tmp/restore.sql.gz | PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE"
