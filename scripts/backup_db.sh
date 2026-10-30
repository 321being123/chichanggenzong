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
#   - 按"备份组"保留最近 N 组（一组 = 同时间戳的全部产物），默认 3 组；可用 BACKUP_KEEP_GROUPS 覆盖
#   - 生产建议 REQUIRE_ENCRYPTION=1 强制加密；普通本地/受控环境可不加密
#
# 反馈附件（2026-10-23）:
#   同一备份组同时包含数据库密文、反馈截图归档密文与文件清单，三者共享同一时间戳编号：
#     <库名>_<时间戳>.sql.gz[.gpg]              数据库
#     <库名>_<时间戳>.attachments.tar.gz[.gpg]  反馈截图（仅最终 WebP 文件，不含原图/临时文件）
#     <库名>_<时间戳>.manifest.sha256           清单与本组产物校验和
#   整组成功才写入清单；缺附件目录时仍生成清单并注明内容为空，不伪造附件已备份。
#   备份期间不执行附件物理清理（本脚本不含清理动作，避免误删仍被历史引用的文件）。
#
# 运维要点:
#   - RPO：每天 1 份 => 最多丢失约 1 天数据。更短则改为每小时并调整保留组数。
#   - RTO：恢复 = 校验密文 -> gpg 解密 -> gunzip -> psql 导入。应定期做恢复演练确认可用。
#   - 异地存储：把 backups/ 同步到对象存储/另一台机器，避免单机故障导致备份与数据库同归于尽。

set -euo pipefail

# 读取项目根目录的 .env（若存在）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
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
# 反馈截图目录：优先显式配置，其次 DATA_DIR，最后项目 data/
ATTACH_DIR="${FEEDBACK_UPLOAD_DIR:-${DATA_DIR:-$ROOT_DIR/data}/feedback-uploads}"

# ---------- 辅助函数 ----------

# 从产物文件名反推"备份组基名"（去掉类型后缀与压缩/加密后缀）
# 2026-10-30 修：原来只剥一层后缀，`X.sql.gz.gpg.sha256` 会被剥成 `X.sql.gz.gpg`，
# 同一组因此算出多个基名，导致「保留 14 组」实际只留下约 3—4 组（按 mtime 排序时
# 同组文件占掉多个名额），清理脚本也容易把同组的 .sha256 当成另一组删掉。
# 改成循环剥离，直到剥不动为止。
group_base() {
  local name="$1" prev=""
  while [ "$name" != "$prev" ]; do
    prev="$name"
    name="$(printf '%s' "$name" | sed -E 's/\.(manifest\.sha256|attachments\.tar\.gz(\.gpg)?|sql\.gz(\.gpg)?|sha256|gpg)$//')"
  done
  printf '%s' "$name"
}

# 按"备份组基名"保留最近 N 组（一组 = 同时间戳的数据库/附件/清单产物），超出整组删除
prune_backups() {
  local allfiles base k found
  allfiles=$(ls -1t "$BACKUP_DIR"/*"${PGDATABASE}"_* 2>/dev/null) || true
  [ -z "$allfiles" ] && return 0
  local keep=() seen="" cnt=0
  # 保留组数可配：默认 3（2026-10-30 用户要求"最多 3 组"）。一次部署就会触发一组备份，
  # 14 组意味着半个月内可积压十几份近似的全量快照，磁盘占用不划算。
  local keep_groups="${BACKUP_KEEP_GROUPS:-3}"
  case "$keep_groups" in ''|*[!0-9]*) keep_groups=3;; esac
  [ "$keep_groups" -lt 1 ] && keep_groups=1
  while IFS= read -r f; do
    [ -e "$f" ] || continue
    base="$(group_base "$f")"
    case "$seen" in *"|$base|"*) continue;; esac
    seen="$seen|$base|"
    keep+=("$base")
    cnt=$((cnt + 1))
    [ "$cnt" -ge "$keep_groups" ] && break
  done <<< "$allfiles"
  while IFS= read -r f; do
    [ -e "$f" ] || continue
    base="$(group_base "$f")"
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
GROUP="${PGDATABASE}_${STAMP}"
OUT="$BACKUP_DIR/${GROUP}.sql.gz"

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

# ---------- 反馈截图：同组归档，只含最终 WebP 文件 ----------
FINAL_ATT=""
ATTACH_FILES=0
if [ -d "$ATTACH_DIR" ]; then
  ATTACH_FILES=$(find "$ATTACH_DIR" -type f -name '*.webp' 2>/dev/null | wc -l | tr -d ' ')
  if [ "${ATTACH_FILES:-0}" -gt 0 ]; then
    ATT_RAW="$BACKUP_DIR/${GROUP}.attachments.tar.gz"
    # 排除临时/半成品文件；原图本就不落盘（服务端内存压缩后只保存 WebP）
    tar --exclude='*.part' --exclude='*.tmp' --exclude='*.upload' \
      -czf "$ATT_RAW" -C "$ATTACH_DIR" .
    FINAL_ATT="$ATT_RAW"
    if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
      gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase "$BACKUP_PASSPHRASE" -o "$ATT_RAW.gpg" "$ATT_RAW"
      rm -f "$ATT_RAW"
      FINAL_ATT="$ATT_RAW.gpg"
    fi
    sha256sum "$FINAL_ATT" > "$FINAL_ATT.sha256"
    echo "反馈截图归档: $FINAL_ATT（$ATTACH_FILES 个文件）"
  else
    echo "反馈截图目录为空，本组不生成附件归档：$ATTACH_DIR"
  fi
else
  echo "反馈截图目录不存在，本组不生成附件归档：$ATTACH_DIR"
fi

# ---------- 组清单：整组产物齐备后才写入 ----------
MANIFEST="$BACKUP_DIR/${GROUP}.manifest.sha256"
{
  echo "# portfolio backup group ${GROUP}"
  echo "created_at=$(date -Is)"
  echo "database=$(basename "$FINAL")"
  echo "database_sha256=$(sha256sum "$FINAL" | cut -d' ' -f1)"
  if [ -n "$FINAL_ATT" ]; then
    echo "attachments=$(basename "$FINAL_ATT")"
    echo "attachments_sha256=$(sha256sum "$FINAL_ATT" | cut -d' ' -f1)"
    echo "attachment_files=${ATTACH_FILES}"
  else
    echo "attachments=none"
    echo "attachment_files=0"
  fi
  echo "encrypted=$([ -n "${BACKUP_PASSPHRASE:-}" ] && echo 1 || echo 0)"
} > "$MANIFEST"
echo "组清单: $MANIFEST"

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
