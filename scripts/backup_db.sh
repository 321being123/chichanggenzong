#!/usr/bin/env bash
# PostgreSQL 自动备份脚本
#
# 用法:
#   bash scripts/backup_db.sh                                          # 普通备份（BACKUP_PASSPHRASE 可选）
#   REQUIRE_ENCRYPTION=1 BACKUP_PASSPHRASE=xxx bash scripts/backup_db.sh # 生产：强制加密，否则拒绝
#   BACKUP_PASSPHRASE=xxx BACKUP_SELFTEST=1 bash scripts/backup_db.sh    # 临时目录内做加密/校验/解密回合自测
#
# 前置: 项目根目录 .env 含 PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
# 说明:
#   - 本地 pg_dump + gzip 导出
#   - 设置了 BACKUP_PASSPHRASE 则额外做 AES256 对称加密并删除明文（生产数据不外泄）
#   - 对【最终产物】生成 SHA256（加密后为 .gpg，未加密为 .sql.gz）；恢复时先校验密文再解密
#   - 按"备份组"保留最近 14 组（一组 = 同时间戳的 .sql.gz / .gpg / .sha256），超出整组删除
#   - 生产建议 REQUIRE_ENCRYPTION=1 强制加密；普通本地/受控环境可不加密
#
# 运维要点:
#   - RPO：每天 1 份 => 最多丢失约 1 天数据。更短则改为每小时并调整保留组数。
#   - RTO：恢复 = 校验密文 -> gpg 解密 -> gunzip -> psql 导入。应定期做恢复演练确认可用。
#   - 异地存储：把 backups/ 同步到对象存储/另一台机器，避免单机故障导致备份与数据库同归于尽。

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

# ---------- 辅助函数 ----------

# 按"备份组基名"保留最近 N 组（一组 = 同时间戳的 .sql.gz/.gpg/.sha256），超出整组删除
prune_backups() {
  local allfiles base k found
  allfiles=$(ls -1t "$BACKUP_DIR"/*"${PGDATABASE}"_* 2>/dev/null) || true
  [ -z "$allfiles" ] && return 0
  local keep=() seen="" cnt=0
  while IFS= read -r f; do
    [ -e "$f" ] || continue
    base="${f%.sha256}"; base="${base%.gpg}"; base="${base%.sql.gz}"
    case "$seen" in *"|$base|"*) continue;; esac
    seen="$seen|$base|"
    keep+=("$base")
    cnt=$((cnt + 1))
    [ "$cnt" -ge 14 ] && break
  done <<< "$allfiles"
  while IFS= read -r f; do
    [ -e "$f" ] || continue
    base="${f%.sha256}"; base="${base%.gpg}"; base="${base%.sql.gz}"
    found=0
    for k in "${keep[@]}"; do [ "$k" = "$base" ] && found=1 && break; done
    if [ "$found" -eq 0 ]; then rm -f "$f"; echo "清理旧备份: $f"; fi
  done <<< "$allfiles"
}

# 自测：在临时目录模拟一次加密备份，校验并解密比对，验证脚本闭环正确
self_test() {
  local td; td="$(mktemp -d)"
  echo "自测目录: $td"
  export BACKUP_DIR="$td"
  export PGDATABASE="selftest_db"
  local OUT="$td/${PGDATABASE}_$(date +%Y%m%d_%H%M%S).sql.gz"
  echo "dummy sql content" | gzip > "$OUT"
  local FINAL="$OUT"
  if command -v gpg >/dev/null 2>&1 && [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase "$BACKUP_PASSPHRASE" -o "$OUT.gpg" "$OUT"
    rm -f "$OUT"; FINAL="$OUT.gpg"
    sha256sum "$FINAL" > "$FINAL.sha256"
    sha256sum -c "$FINAL.sha256"
    gpg --batch --yes --decrypt --passphrase "$BACKUP_PASSPHRASE" "$FINAL" > "$td/restore.sql.gz"
    if gunzip -c "$td/restore.sql.gz" | diff -q - <(echo "dummy sql content") >/dev/null; then
      echo "自测通过：加密 / 校验 / 解密 一致 ✅"
    else echo "自测失败：解密内容不一致" >&2; rm -rf "$td"; exit 1; fi
  else
    sha256sum "$FINAL" > "$FINAL.sha256"
    sha256sum -c "$FINAL.sha256"
    echo "自测（未加密路径）：校验通过"
  fi
  rm -rf "$td"
}

# ---------- 自测优先 ----------

if [ "${BACKUP_SELFTEST:-0}" = "1" ]; then
  self_test
  exit 0
fi

mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/${PGDATABASE}_${STAMP}.sql.gz"

# 生产强制加密：缺少口令则拒绝生成未加密备份
if [ "${REQUIRE_ENCRYPTION:-0}" = "1" ] && [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "错误：REQUIRE_ENCRYPTION=1 但缺少 BACKUP_PASSPHRASE，拒绝生成未加密备份" >&2
  exit 1
fi

echo "备份 $PGDATABASE -> $OUT"
PGPASSWORD="$PGPASSWORD" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  --no-owner --clean --if-exists | gzip > "$OUT"

# 加密（设置了 BACKUP_PASSPHRASE 才启用；密码仅来自环境变量，不落盘、不硬编码）
FINAL="$OUT"
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase "$BACKUP_PASSPHRASE" -o "$OUT.gpg" "$OUT"
  rm -f "$OUT"   # 不保留明文，避免敏感数据以明文形式留存
  FINAL="$OUT.gpg"
  echo "已加密: $FINAL"
fi

# 对【最终产物】生成 SHA256（恢复时先校验再解密）
sha256sum "$FINAL" > "$FINAL.sha256"
echo "校验文件: $FINAL.sha256 ($(du -h "$FINAL" | cut -f1))"

# 保留最近 14 组，超出整组删除
prune_backups

echo "备份完成：保留最近 14 组"

# ===== 恢复演练（手动执行示例，不在定时备份中自动跑） =====
# 校验密文完整性:
#   sha256sum -c backups/<库名>_<时间戳>.sql.gz.gpg.sha256
# 解密（若已加密）:
#   gpg --batch --yes --decrypt --passphrase "$BACKUP_PASSPHRASE" backups/<库名>_<时间戳>.sql.gz.gpg > /tmp/restore.sql.gz
# 导入:
#   gunzip -c /tmp/restore.sql.gz | PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE"
