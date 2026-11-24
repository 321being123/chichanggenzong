#!/bin/sh
set -eu
umask 077

backup_dir=/backup
log_file=$backup_dir/weekly.log
exec 9>"$backup_dir/.weekly.lock"
flock -n 9 || exit 0

stamp=$(date +%Y%m%d_%H%M%S)
temporary=$(mktemp -d "$backup_dir/.incoming-weekly.XXXXXX")
complete=$backup_dir/weekly_"$stamp"

finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    printf '%s backup failed (exit %s)\n' "$(date -Iseconds)" "$result" | tee -a "$log_file" >&2
  fi
  rm -f -- "$temporary/database.dump.gpg" "$temporary/attachments.tar.gz.gpg" "$temporary/SHA256SUMS"
  rmdir -- "$temporary" 2>/dev/null || true
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pull() {
  ssh -F /dev/null -T -i /backup-ssh/key \
    -o UserKnownHostsFile=/backup-ssh/known_hosts \
    -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes \
    -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=4 \
    ubuntu@82.156.125.47 "$1"
}

printf '%s backup started\n' "$(date -Iseconds)" | tee -a "$log_file"
pull fresh-db >"$temporary/database.dump.gpg"
pull fresh-attachments >"$temporary/attachments.tar.gz.gpg"
(
  cd "$temporary"
  test -s database.dump.gpg
  test -s attachments.tar.gz.gpg
  sha256sum database.dump.gpg attachments.tar.gz.gpg >SHA256SUMS
  sha256sum -c SHA256SUMS
)
mv -T -- "$temporary" "$complete"
printf '%s backup complete %s\n' "$(date -Iseconds)" "$complete" | tee -a "$log_file"
