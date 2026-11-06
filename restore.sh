#!/usr/bin/env bash
# بازیابی: ابتدا سرور را متوقف کنید.  ./restore.sh backups/fitos-XXXX.db
set -euo pipefail; cd "$(dirname "$0")"
[ -f "${1:-}" ] || { echo "usage: $0 <backup.db>"; exit 1; }
[ -f fitos.db ] && cp fitos.db "fitos.db.before-restore-$(date +%s)"
rm -f fitos.db-wal fitos.db-shm; cp "$1" fitos.db; chmod 600 fitos.db; echo "Restored from $1"
