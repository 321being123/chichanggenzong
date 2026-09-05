#!/usr/bin/env bash
# 在隔离 PostgreSQL 数据库中做一次加密备份恢复演练。
# 默认演练后删除临时库；任何非 portfolio_restore_drill_ 前缀的库名都会被拒绝。

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
TARGET_DB="${RESTORE_DRILL_DATABASE:-portfolio_restore_drill_$(date +%Y%m%d_%H%M%S)}"
KEEP_DATABASE="${RESTORE_DRILL_KEEP_DATABASE:-0}"

if [[ ! "$TARGET_DB" =~ ^portfolio_restore_drill_[0-9]{8}_[0-9]{6}$ ]]; then
  echo "错误：恢复演练数据库名必须匹配 portfolio_restore_drill_YYYYMMDD_HHMMSS" >&2
  exit 1
fi
if [ "$TARGET_DB" = "${PGDATABASE:-portfolio}" ]; then
  echo "错误：拒绝把生产数据库作为恢复演练目标" >&2
  exit 1
fi

latest="${1:-}"
if [ -z "$latest" ]; then
  latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -nr | sed -n '1s/^[^ ]* //p')"
fi
[ -n "$latest" ] || { echo "错误：没有可用于恢复演练的 .gpg 备份" >&2; exit 1; }
[ -f "$latest" ] || { echo "错误：备份文件不存在：$latest" >&2; exit 1; }
case "$latest" in
  *.gpg) ;;
  *) echo "错误：恢复演练只接受 .gpg 加密备份" >&2; exit 1;;
esac
checksum="$latest.sha256"
[ -f "$checksum" ] || { echo "错误：缺少校验文件：$checksum" >&2; exit 1; }
(
  cd "$(dirname "$latest")"
  sha256sum -c "$(basename "$checksum")"
)

: "${BACKUP_PASSPHRASE:?错误：恢复演练缺少 BACKUP_PASSPHRASE}"
command -v gpg >/dev/null 2>&1 || { echo "错误：缺少 gpg" >&2; exit 1; }
command -v gunzip >/dev/null 2>&1 || { echo "错误：缺少 gunzip" >&2; exit 1; }
command -v runuser >/dev/null 2>&1 || { echo "错误：缺少 runuser" >&2; exit 1; }

PG_LOCAL=(runuser -u postgres -- env -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD)
cleanup() {
  if [ "$KEEP_DATABASE" != "1" ]; then
    "${PG_LOCAL[@]}" dropdb --if-exists --maintenance-db=postgres "$TARGET_DB" >/dev/null 2>&1 || true
  fi
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
echo "恢复演练通过：用户对象 $table_count 个，schema_migrations $migration_count 条"
