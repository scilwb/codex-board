#!/usr/bin/env bash
set -euo pipefail
systemctl --user start codex-board.service
for attempt in {1..30}; do
  if curl --silent --fail http://127.0.0.1:4317/api/snapshot >/dev/null; then
    exec xdg-open http://127.0.0.1:4317
  fi
  sleep 0.2
done
printf 'Codex Board 启动失败，请查看：journalctl --user -u codex-board.service -n 30\n' >&2
exit 1
