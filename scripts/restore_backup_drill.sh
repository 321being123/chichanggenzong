#!/usr/bin/env bash
# 在隔离 PostgreSQL 数据库中做一次加密备份组恢复演练（2026-10-23 起按整组）。
# 默认演练后删除临时库与隔离附件目录；任何非 portfolio_restore_drill_ 前缀的库名都会被拒绝。
# 组内产物：数据库密文（*.sql.gz.gpg）、反馈截图密文（*.attachments.tar.gz.gpg，可选）、组清单（*.manifest.sha256，必需）。
# 缺少清单或清单声明存在的附件密文 → 视为备份组不完整，拒绝恢复。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${BACKUP_ENV_FILE:-/etc/portfolio/backup.env}"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-/var/backups/portfolio}"
PRODUCTION_DB="${PGDATABASE:-portfolio}"
TARGET_DB="${RESTORE_DRILL_DATABASE:-portfolio_restore_drill_$(date +%Y%m%d_%H%M%S)}"
KEEP_DATABASE="${RESTORE_DRILL_KEEP_DATABASE:-0}"
REMOTE_URI="${RESTORE_DRILL_BACKUP_URI:-}"
DOWNLOAD_DIR=""
DRILL_ATTACH_DIR=""

cleanup_download() {
  if [ -n "$DOWNLOAD_DIR" ] && [ -d "$DOWNLOAD_DIR" ]; then
    rm -rf -- "$DOWNLOAD_DIR"
  fi
  if [ -n "$DRILL_ATTACH_DIR" ] && [ -d "$DRILL_ATTACH_DIR" ]; then
    rm -rf -- "$DRILL_ATTACH_DIR"
  fi
}

if [[ ! "$TARGET_DB" =~ ^portfolio_restore_drill_[0-9]{8}_[0-9]{6}$ ]]; then
  echo "错误：恢复演练数据库名必须匹配 portfolio_restore_drill_YYYYMMDD_HHMMSS" >&2
  exit 1
fi
if [ "$TARGET_DB" = "$PRODUCTION_DB" ]; then
  echo "错误：拒绝把生产数据库作为恢复演练目标" >&2
  exit 1
fi

latest="${1:-}"
if [ -z "$latest" ] && [ -n "$REMOTE_URI" ]; then latest="$REMOTE_URI"; fi
if [[ "$latest" == s3://* ]]; then
  [[ "$latest" =~ ^s3://[A-Za-z0-9][A-Za-z0-9._-]{1,62}(/[^[:space:]]+)?\.sql\.gz\.gpg$ ]] || { echo "错误：异地恢复地址必须指向数据库密文 s3://bucket/path/<组>.sql.gz.gpg" >&2; exit 1; }
  command -v aws >/dev/null 2>&1 || { echo "错误：异地恢复需要 aws 客户端" >&2; exit 1; }
  DOWNLOAD_DIR="$(mktemp -d /tmp/portfolio-restore.XXXXXX)"
  endpoint_args=()
  if [ -n "${BACKUP_STORAGE_ENDPOINT:-}" ]; then endpoint_args+=(--endpoint-url "$BACKUP_STORAGE_ENDPOINT"); fi
  remote_group="${latest%.sql.gz.gpg}"
  aws s3 cp "$latest" "$DOWNLOAD_DIR/$(basename "$latest")" --only-show-errors "${endpoint_args[@]}"
  aws s3 cp "$latest.sha256" "$DOWNLOAD_DIR/$(basename "$latest").sha256" --only-show-errors "${endpoint_args[@]}"
  aws s3 cp "${remote_group}.manifest.sha256" "$DOWNLOAD_DIR/$(basename "$remote_group").manifest.sha256" --only-show-errors "${endpoint_args[@]}"
  latest="$DOWNLOAD_DIR/$(basename "$latest")"
fi
if [ -z "$latest" ]; then
  latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sql.gz.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -nr | sed -n '1s/^[^ ]* //p')"
fi
[ -n "$latest" ] || { echo "错误：没有可用于恢复演练的数据库密文（*.sql.gz.gpg）" >&2; exit 1; }
[ -f "$latest" ] || { echo "错误：备份文件不存在：$latest" >&2; exit 1; }
case "$latest" in
  *.sql.gz.gpg) ;;
  *.attachments.tar.gz.gpg) echo "错误：请传入数据库密文（*.sql.gz.gpg），脚本按整组恢复" >&2; exit 1;;
  *) echo "错误：恢复演练只接受数据库密文（*.sql.gz.gpg）" >&2; exit 1;;
esac
checksum="$latest.sha256"
[ -f "$checksum" ] || { echo "错误：缺少校验文件：$checksum" >&2; exit 1; }
(
  cd "$(dirname "$latest")"
  sha256sum -c "$(basename "$checksum")"
)

# ---------- 整组完整性：清单必需，清单声明的附件密文也必须存在 ----------
group="${latest%.sql.gz.gpg}"
manifest="${group}.manifest.sha256"
[ -f "$manifest" ] || { echo "错误：备份组缺少清单 ${manifest}，视为组不完整，拒绝恢复" >&2; exit 1; }
att_value="$(grep -E '^attachments=' "$manifest" | head -1 | cut -d= -f2-)"
attachments=""
if [ -n "$att_value" ] && [ "$att_value" != "none" ]; then
  attachments="$(dirname "$latest")/${att_value}"
  [ -f "$attachments" ] || { echo "错误：清单声明有反馈截图归档，但缺少 $attachments，拒绝恢复" >&2; exit 1; }
  [ -f "$attachments.sha256" ] || { echo "错误：缺少附件归档校验文件 $attachments.sha256" >&2; exit 1; }
fi

: "${BACKUP_PASSPHRASE:?错误：恢复演练缺少 BACKUP_PASSPHRASE}"
command -v gpg >/dev/null 2>&1 || { echo "错误：缺少 gpg" >&2; exit 1; }
command -v gunzip >/dev/null 2>&1 || { echo "错误：缺少 gunzip" >&2; exit 1; }
command -v runuser >/dev/null 2>&1 || { echo "错误：缺少 runuser" >&2; exit 1; }

PG_LOCAL=(runuser -u postgres -- env -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD)
KEY_TABLES=(public.users public.accounts public.positions public.trades public.nav_history core.instruments)
declare -A PRODUCTION_COUNTS
for table in "${KEY_TABLES[@]}"; do
  count="$("${PG_LOCAL[@]}" psql -X -At --dbname="$PRODUCTION_DB" -c "SELECT count(*) FROM $table;")"
  case "$count" in ''|*[!0-9]*) echo "错误：无法读取生产表 $table 的行数" >&2; exit 1;; esac
  PRODUCTION_COUNTS["$table"]="$count"
done

cleanup_failed=0
cleanup() {
  local rc=$?
  if [ "$KEEP_DATABASE" != "1" ]; then
    if ! "${PG_LOCAL[@]}" dropdb --if-exists --maintenance-db=postgres "$TARGET_DB" >/dev/null 2>&1; then
      cleanup_failed=1
      echo "错误：恢复演练临时库清理失败：$TARGET_DB" >&2
    fi
  fi
  cleanup_download
  if [ "$cleanup_failed" -ne 0 ] && [ "$rc" -eq 0 ]; then rc=1; fi
  exit "$rc"
}
trap cleanup EXIT

"${PG_LOCAL[@]}" dropdb --if-exists --maintenance-db=postgres "$TARGET_DB" >/dev/null
"${PG_LOCAL[@]}" createdb --maintenance-db=postgres "$TARGET_DB"

echo "恢复演练开始：$latest -> $TARGET_DB"
gpg --batch --yes --pinentry-mode loopback --decrypt --passphrase "$BACKUP_PASSPHRASE" "$latest" \
  | gunzip -c \
  | "${PG_LOCAL[@]}" psql -X --set=ON_ERROR_STOP=1 --quiet --dbname="$TARGET_DB" >/dev/null

table_count="$("${PG_LOCAL[@]}" psql -X -At --dbname="$TARGET_DB" -c \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%';")"
migration_count="$("${PG_LOCAL[@]}" psql -X -At --dbname="$TARGET_DB" -c \
  "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN 0 ELSE (SELECT count(*) FROM public.schema_migrations) END;")"

case "$table_count" in ''|*[!0-9]*) echo "错误：恢复后对象数量无法读取" >&2; exit 1;; esac
if [ "$table_count" -lt 1 ]; then
  echo "错误：恢复后没有发现用户对象" >&2
  exit 1
fi
case "$migration_count" in ''|*[!0-9]*) echo "错误：schema_migrations 行数无法读取" >&2; exit 1;; esac
if [ "$migration_count" -lt 1 ]; then
  echo "错误：恢复后没有迁移记录" >&2
  exit 1
fi
for table in "${KEY_TABLES[@]}"; do
  restored_count="$("${PG_LOCAL[@]}" psql -X -At --dbname="$TARGET_DB" -c "SELECT count(*) FROM $table;")"
  if [ "$restored_count" != "${PRODUCTION_COUNTS[$table]}" ]; then
    echo "错误：关键表 $table 对账失败（生产 ${PRODUCTION_COUNTS[$table]}，恢复 $restored_count）" >&2
    exit 1
  fi
done

# ---------- 反馈截图：解密到隔离目录，按恢复库引用逐项核对 ----------
if [ -n "$attachments" ]; then
  command -v tar >/dev/null 2>&1 || { echo "错误：缺少 tar" >&2; exit 1; }
  DRILL_ATTACH_DIR="$(mktemp -d /tmp/portfolio-restore-attach.XXXXXX)"
  chmod 0700 "$DRILL_ATTACH_DIR"
  att_plain="$(mktemp /tmp/portfolio-restore-attach.XXXXXX.tar.gz)"
  gpg --batch --yes --pinentry-mode loopback --decrypt --passphrase "$BACKUP_PASSPHRASE" "$attachments" > "$att_plain"
  # 安全解包：拒绝绝对路径与 .. 穿越
  if tar -tzf "$att_plain" | grep -Eq '^/|(^|/)\.\.(/|$)'; then
    rm -f "$att_plain"
    echo "错误：附件归档包含不安全路径，拒绝解包" >&2
    exit 1
  fi
  tar -xzf "$att_plain" -C "$DRILL_ATTACH_DIR"
  rm -f "$att_plain"

  att_rows="$("${PG_LOCAL[@]}" psql -X -At --dbname="$TARGET_DB" -c \
    "SELECT CASE WHEN to_regclass('public.feedback_attachments') IS NULL THEN 0 ELSE (SELECT count(*) FROM public.feedback_attachments) END;")"
  case "$att_rows" in ''|*[!0-9]*) echo "错误：恢复后反馈附件行数无法读取" >&2; exit 1;; esac
  if [ "$att_rows" -gt 0 ]; then
    missing=0
    mismatch=0
    while IFS='|' read -r key hash size; do
      [ -n "$key" ] || continue
      f="$DRILL_ATTACH_DIR/$key"
      if [ ! -f "$f" ]; then missing=$((missing + 1)); echo "缺少附件文件：$key" >&2; continue; fi
      actual_size="$(stat -c '%s' "$f")"
      actual_hash="$(sha256sum "$f" | cut -d' ' -f1)"
      if [ "$actual_size" != "$size" ] || [ "$actual_hash" != "$hash" ]; then
        mismatch=$((mismatch + 1)); echo "附件校验不符：$key" >&2
      fi
    done <<< "$("${PG_LOCAL[@]}" psql -X -At -F'|' --dbname="$TARGET_DB" -c \
      "SELECT storage_key, sha256, size_bytes FROM public.feedback_attachments ORDER BY id;")"
    if [ "$missing" -ne 0 ] || [ "$mismatch" -ne 0 ]; then
      echo "错误：附件恢复核对失败（缺失 $missing，校验不符 $mismatch）" >&2
      exit 1
    fi
    echo "反馈附件恢复核对通过：$att_rows 条引用全部存在且哈希一致"
  else
    echo "反馈附件：恢复库无引用记录，解包目录为空属正常"
  fi
else
  echo "反馈附件：本备份组未包含截图归档（清单 attachments=none）"
fi

echo "恢复演练通过：用户对象 $table_count 个，schema_migrations $migration_count 条"
