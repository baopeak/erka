#!/usr/bin/env bash
# Dev helper: (re)build and run kelpied on an isolated endpoint/data dir.
#   scripts/dev-daemon.sh stop   - stop the dev daemon
#   scripts/dev-daemon.sh run    - stop, rebuild (release) and run in foreground
set -euo pipefail
cd "$(dirname "$0")/.."
: "${KELPIE_ENDPOINT:=kelpie-dev}"
: "${KELPIE_DATA_DIR:=${TMPDIR:-/tmp}/kelpie-dev}"
export KELPIE_ENDPOINT KELPIE_DATA_DIR
stop() {
  local lock="$KELPIE_DATA_DIR/kelpied.pid"
  [ -f "$lock" ] || return 0
  local pid; pid=$(cat "$lock" 2>/dev/null || true)
  [ -n "$pid" ] || return 0
  if command -v taskkill >/dev/null 2>&1; then taskkill //PID "$pid" //F >/dev/null 2>&1 || true
  else kill "$pid" 2>/dev/null || true; fi
  sleep 0.5
}
case "${1:-run}" in
  stop) stop ;;
  run) stop; cargo build --release -q -p kelpied; exec cargo run --release -q -p kelpied -- serve ;;
esac
