#!/usr/bin/env bash
# 将本机加密备份及校验文件同步到 S3 兼容对象存储。
# 只接受 .gpg 与对应 .sha256，禁止上传明文 SQL。

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

if [ "${BACKUP_OFFSITE_ENABLED:-0}" != "1" ]; then
  echo "异地备份同步未启用（BACKUP_OFFSITE_ENABLED!=1）"
  exit 0
fi

BACKUP_DIR="${BACKUP_DIR:-/var/backups/portfolio}"
STORAGE_URI="${BACKUP_STORAGE_URI:-}"
PROVIDER="${BACKUP_STORAGE_PROVIDER:-s3}"

if [ "$PROVIDER" != "s3" ]; then
  echo "错误：BACKUP_STORAGE_PROVIDER 只支持 s3，当前为 $PROVIDER" >&2
  exit 1
fi
if [[ ! "$STORAGE_URI" =~ ^s3://[A-Za-z0-9][A-Za-z0-9._-]{1,62}(/[^[:space:]]*)?$ ]]; then
  echo "错误：BACKUP_STORAGE_URI 必须是 s3://bucket/prefix 格式" >&2
  exit 1
fi

if [ "${REQUIRE_ENCRYPTION:-0}" != "1" ]; then
  echo "错误：异地同步要求 REQUIRE_ENCRYPTION=1" >&2
  exit 1
fi

latest="${1:-}"
if [ -z "$latest" ]; then
  latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -nr | sed -n '1s/^[^ ]* //p')"
fi
[ -n "$latest" ] || { echo "错误：没有可同步的 .gpg 备份" >&2; exit 1; }
[ -f "$latest" ] || { echo "错误：备份文件不存在：$latest" >&2; exit 1; }
case "$latest" in
  *.gpg) ;;
  *) echo "错误：只允许同步 .gpg 加密备份" >&2; exit 1;;
esac
checksum="$latest.sha256"
[ -f "$checksum" ] || { echo "错误：缺少校验文件：$checksum" >&2; exit 1; }
(
  cd "$(dirname "$latest")"
  sha256sum -c "$(basename "$checksum")"
)

base="$(basename "$latest")"
checksum_base="$(basename "$checksum")"
remote_base="${STORAGE_URI%/}"

if command -v aws >/dev/null 2>&1; then
  endpoint_args=()
  if [ -n "${BACKUP_STORAGE_ENDPOINT:-}" ]; then
    endpoint_args+=(--endpoint-url "$BACKUP_STORAGE_ENDPOINT")
  fi
  aws s3 cp "$latest" "$remote_base/$base" --only-show-errors "${endpoint_args[@]}"
  aws s3 cp "$checksum" "$remote_base/$checksum_base" --only-show-errors "${endpoint_args[@]}"
  bucket_key="${STORAGE_URI#s3://}"
  bucket="${bucket_key%%/*}"
  prefix=""
  [[ "$bucket_key" == */* ]] && prefix="${bucket_key#*/}"
  key="$base"
  [ -z "$prefix" ] || key="${prefix%/}/$base"
  aws s3api head-object --bucket "$bucket" --key "$key" "${endpoint_args[@]}" >/dev/null
  key="$checksum_base"
  [ -z "$prefix" ] || key="${prefix%/}/$checksum_base"
  aws s3api head-object --bucket "$bucket" --key "$key" "${endpoint_args[@]}" >/dev/null
  echo "异地同步完成（aws）：$base、$checksum_base"
elif command -v rclone >/dev/null 2>&1; then
  rclone copyto "$latest" "$remote_base/$base" --immutable --no-checksum
  rclone copyto "$checksum" "$remote_base/$checksum_base" --immutable --no-checksum
  rclone size "$remote_base/$base" --json >/dev/null
  rclone size "$remote_base/$checksum_base" --json >/dev/null
  echo "异地同步完成（rclone）：$base、$checksum_base"
else
  echo "错误：未安装 aws 或 rclone，无法执行对象存储同步" >&2
  exit 1
fi
