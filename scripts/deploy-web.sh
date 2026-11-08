#!/usr/bin/env bash
# Обновление веб-версии «Обозревателя» на ВДС.
#
# Первичная установка (systemd + nginx) выполняется один раз вручную (см. docs/WEB.md),
# этот скрипт — для последующих обновлений: синхронизирует код и перезапускает сервис.
#
# Использование:
#   bash scripts/deploy-web.sh                      # openclaw@37.46.18.40
#   bash scripts/deploy-web.sh user@host            # другой хост
#   OBOZ_REMOTE_DIR=/srv/oboz bash scripts/deploy-web.sh
set -euo pipefail

HOST="${1:-openclaw@37.46.18.40}"
REMOTE_DIR="${OBOZ_REMOTE_DIR:-/home/openclaw/oboz}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_URL="${OBOZ_PUBLIC_URL:-https://agonarena.ru/oboz/}"

echo "→ синхронизация $ROOT → $HOST:$REMOTE_DIR"
rsync -az --delete \
  --exclude '.git' \
  --exclude '.cache' \
  --exclude '.state' \
  --exclude 'node_modules' \
  --exclude 'test' \
  --exclude 'scripts/tui-smoke.py' \
  "$ROOT/" "$HOST:$REMOTE_DIR/"

echo "→ перезапуск oboz-web"
ssh -n "$HOST" "sudo -n systemctl restart oboz-web && sleep 1 && sudo -n systemctl is-active oboz-web"

echo "→ проверка $PUBLIC_URL"
curl -fsS -m 20 "${PUBLIC_URL}healthz" && echo
echo "Готово: $PUBLIC_URL"
