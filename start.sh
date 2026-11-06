#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo "Run ./setup.sh first."
  exit 1
fi
node --check fitos.mjs
exec node fitos.mjs
