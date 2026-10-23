#!/usr/bin/env bash
# 将本机加密备份组（数据库密文 + 反馈截图密文 + 组清单）同步到 S3 兼容对象存储。
# 只接受 .gpg 与清单/校验文件，禁止上传明文 SQL 或明文附件归档。
# 2026-10-23：按"备份组"整体同步；缺组内必需产物视为组不完整，拒绝上传部分组。

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
  latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sql.gz.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -nr | sed -n '1s/^[^ ]* //p')"
fi
[ -n "$latest" ] || { echo "错误：没有可同步的数据库 .gpg 备份组" >&2; exit 1; }
[ -f "$latest" ] || { echo "错误：备份文件不存在：$latest" >&2; exit 1; }
case "$latest" in
  *.sql.gz.gpg) ;;
  *.attachments.tar.gz.gpg) echo "错误：请传入数据库密文（*.sql.gz.gpg），脚本按整组同步" >&2; exit 1;;
  *) echo "错误：只允许同步加密备份组（*.sql.gz.gpg）" >&2; exit 1;;
esac

group="${latest%.sql.gz.gpg}"
checksum="$latest.sha256"
manifest="${group}.manifest.sha256"
[ -f "$checksum" ] || { echo "错误：缺少校验文件：$checksum" >&2; exit 1; }
[ -f "$manifest" ] || { echo "错误：备份组缺少清单 ${manifest}，视为组不完整，拒绝同步" >&2; exit 1; }

# 清单声明存在附件归档时必须找到附件密文，否则整组视为不完整
attachments=""
att_checksum=""
att_value="$(grep -E '^attachments=' "$manifest" | head -1 | cut -d= -f2-)"
if [ -n "$att_value" ] && [ "$att_value" != "none" ]; then
  attachments="${group}.attachments.tar.gz.gpg"
  att_checksum="${attachments}.sha256"
  [ -f "$attachments" ] || { echo "错误：清单声明有反馈截图归档，但缺少 ${attachments}，拒绝同步" >&2; exit 1; }
  [ -f "$att_checksum" ] || { echo "错误：缺少附件归档校验文件 ${att_checksum}" >&2; exit 1; }
fi

(
  cd "$(dirname "$latest")"
  sha256sum -c "$(basename "$checksum")"
  [ -z "$attachments" ] || sha256sum -c "$(basename "$att_checksum")"
)

remote_base="${STORAGE_URI%/}"
upload_list=("$latest" "$checksum" "$manifest")
[ -z "$attachments" ] || upload_list+=("$attachments" "$att_checksum")

if command -v aws >/dev/null 2>&1; then
  endpoint_args=()
  if [ -n "${BACKUP_STORAGE_ENDPOINT:-}" ]; then
    endpoint_args+=(--endpoint-url "$BACKUP_STORAGE_ENDPOINT")
  fi
  bucket_key="${STORAGE_URI#s3://}"
  bucket="${bucket_key%%/*}"
  prefix=""
  [[ "$bucket_key" == */* ]] && prefix="${bucket_key#*/}"
  for f in "${upload_list[@]}"; do
    name="$(basename "$f")"
    aws s3 cp "$f" "$remote_base/$name" --only-show-errors "${endpoint_args[@]}"
    key="$name"
    [ -z "$prefix" ] || key="${prefix%/}/$name"
    aws s3api head-object --bucket "$bucket" --key "$key" "${endpoint_args[@]}" >/dev/null
  done
  echo "异地同步完成（aws）：组 $(basename "$group")，共 ${#upload_list[@]} 个文件"
elif command -v rclone >/dev/null 2>&1; then
  for f in "${upload_list[@]}"; do
    name="$(basename "$f")"
    rclone copyto "$f" "$remote_base/$name" --immutable --no-checksum
    rclone size "$remote_base/$name" --json >/dev/null
  done
  echo "异地同步完成（rclone）：组 $(basename "$group")，共 ${#upload_list[@]} 个文件"
else
  echo "错误：未安装 aws 或 rclone，无法执行对象存储同步" >&2
  exit 1
fi
