#!/bin/bash
# This forced SSH command accepts only fixed read-only exports.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

backup_dir=/var/backups/portfolio
action=${1:-${SSH_ORIGINAL_COMMAND:-latest}}
fail() { printf '%s\n' "$*" >&2; exit 1; }

emit_legacy_group() {
  local base=$1
  local names=("$base.sql.gz.gpg" "$base.sql.gz.gpg.sha256" "$base.manifest.sha256")
  if [[ -f "$backup_dir/$base.attachments.tar.gz.gpg" ]]; then
    names+=("$base.attachments.tar.gz.gpg" "$base.attachments.tar.gz.gpg.sha256")
  fi
  tar -czf - -C "$backup_dir" -- "${names[@]}"
}

encrypt_stream() {
  gpg --batch --no-options --pinentry-mode loopback --no-symkey-cache \
    --compress-algo none --cipher-algo AES256 --passphrase-fd 3 \
    --symmetric --output - 3<<<"$BACKUP_PASSPHRASE"
}

case "$action" in
  list)
    find "$backup_dir" -maxdepth 1 -type f -name 'portfolio_*.sql.gz.gpg' -printf '%f\n' |
      sed -nE 's/^portfolio_([0-9]{8}_[0-9]{6})\.sql\.gz\.gpg$/\1/p' | sort -r
    ;;
  latest)
    latest=$("$0" list | sed -n '1p')
    [[ -n "$latest" ]] || fail 'No historical backup found'
    emit_legacy_group "portfolio_$latest"
    ;;
  group:*)
    group=${action#group:}
    [[ "$group" =~ ^[0-9]{8}_[0-9]{6}$ ]] || fail 'Invalid backup group'
    emit_legacy_group "portfolio_$group"
    ;;
  fresh-db|fresh-attachments)
    if (( EUID != 0 )); then
      exec sudo -n /usr/local/bin/portfolio-backup-export.sh "$action"
    fi
    [[ "$(stat -c '%a %u' /etc/portfolio/backup.env)" == '600 0' ]] ||
      fail 'Invalid permissions on /etc/portfolio/backup.env'
    # shellcheck disable=SC1091
    source /etc/portfolio/backup.env
    : "${BACKUP_PASSPHRASE:?Missing backup passphrase}"
    export GNUPGHOME=/etc/portfolio/nas-backup-gnupg
    if [[ "$action" == fresh-db ]]; then
      runuser -u postgres -- env PGOPTIONS='-c default_transaction_read_only=on' \
        pg_dump --host=/var/run/postgresql --username=postgres --dbname=portfolio \
        --format=custom --no-password | encrypt_stream
    else
      runuser -u portfolio-app -- tar -czf - --exclude='*.tmp' --exclude='*.part' \
        --exclude='*.upload' -C /opt/portfolio/data/feedback-uploads . | encrypt_stream
    fi
    ;;
  *) fail 'Usage: list | latest | group:<timestamp> | fresh-db | fresh-attachments' ;;
esac
