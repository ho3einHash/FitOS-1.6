#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "=== FitOS setup ==="
command -v node >/dev/null 2>&1 || { echo "Node.js 22.13+ لازم است (Termux: pkg install nodejs)"; exit 1; }
[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ] || { echo "Node.js 22 یا بالاتر لازم است."; exit 1; }
if [ ! -f .env ]; then
  read -r -p "Owner email : " OE; OE="${OE:-}"
  while true; do read -r -s -p "Owner password (min 12 chars): " OP; echo; [ "${#OP}" -ge 12 ] && break; echo "رمز کوتاه است."; done
  read -r -p "Bank card number : " BC; BC="${BC:-}"
  read -r -p "Card holder: " BH; BH="${BH:-}"
  read -r -s -p "Telegram bot token (اختیاری؛ Enter برای رد کردن): " TT; echo
  read -r -p "Telegram owner chat id : " TC; TC="${TC:-}"
  umask 077
  printf 'OWNER_EMAIL=%s\nOWNER_PASSWORD=%s\nBANK_CARD_NUMBER=%s\nBANK_CARD_HOLDER=%s\nSUPPORT_TELEGRAM=\nTELEGRAM_BOT_TOKEN=%s\nTELEGRAM_OWNER_CHAT_ID=%s\nPUBLIC_URL=http://127.0.0.1:3000\nHOST=0.0.0.0\nPORT=3000\n' "$OE" "$OP" "$BC" "$BH" "$TT" "$TC" > .env
  chmod 600 .env; echo ".env خصوصی ساخته شد."
else echo ".env موجود است؛ تغییر نکرد."; fi
node --check fitos.mjs && echo "OK. اجرا: ./start.sh"
