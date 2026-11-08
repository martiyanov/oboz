#!/bin/bash
# Установка/удаление launchd-агента для часового обзора «Обозреватель».
# Использование:
#   bash scripts/install-launchd.sh              # установить (каждый час)
#   bash scripts/install-launchd.sh --uninstall  # удалить
#   bash scripts/install-launchd.sh --dry-run    # только показать plist
#
# Скрипт пишет только ~/Library/LaunchAgents/ru.oboz.watch.plist и логи в .state/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="ru.oboz.watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node || true)"
MODE="${1:-install}"

if [[ -z "$NODE_BIN" ]]; then
  echo "Не найден node. Установите Node.js >= 20 (например: brew install node)." >&2
  exit 1
fi

read -r -d '' PLIST_BODY <<EOF || true
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/oboz</string>
    <string>watch</string>
    <string>--every</string>
    <string>60m</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$ROOT/.state/watch.log</string>
  <key>StandardErrorPath</key>
  <string>$ROOT/.state/watch.err.log</string>
</dict>
</plist>
EOF

case "$MODE" in
  --uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Агент $LABEL удалён."
    ;;
  --dry-run)
    echo "$PLIST_BODY"
    ;;
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.state"
    if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      :
    else
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    fi
    printf '%s\n' "$PLIST_BODY" > "$PLIST"
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
    echo "Установлен агент $LABEL (раз в час)."
    echo "Лог:   tail -f \"$ROOT/.state/watch.log\""
    echo "Снять: bash scripts/install-launchd.sh --uninstall"
    ;;
  *)
    echo "Неизвестный режим: $MODE (install | --uninstall | --dry-run)" >&2
    exit 2
    ;;
esac
