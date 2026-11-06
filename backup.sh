#!/usr/bin/env bash
# بکاپ سازگار با WAL از دیتابیس: ./backup.sh
set -euo pipefail; cd "$(dirname "$0")"
mkdir -p backups; F="backups/fitos-$(date +%Y%m%d-%H%M%S).db"
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.DB_PATH||'fitos.db');d.exec(\"VACUUM INTO '\"+process.argv[1]+\"'\");d.close()" "$F"
chmod 600 "$F"; echo "Backup: $F"
