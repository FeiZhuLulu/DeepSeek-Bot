#!/bin/sh
# Mock test bench: the scripted mock model (dev/mock-llm.mjs) plus a dsh web whose profile
# links the plugin to this checkout, so edits need no reinstall (host code needs a restart;
# src/client needs `npm run build` and a page reload).
#
#   dev/bench.sh <name> <web-port> <mock-port> [start|stop|reset|status]
#
# Data lives in <checkout>/.dsh-test-<name>; `reset` wipes its Bot team and Sessions before
# starting. Processes are tracked by pid files and stopped by process group, never by name.
# Environment: CONTEXT_WINDOW (the mock models' context window, in tokens, with an 8,000
# token reply; default: the adapter's own), CHECK_RATIO (the plugin's checkRatio), MOCK_DELAY_MS,
# DSH_HARNESS (the deepseek-harness checkout; default: beside this checkout, else at the
# same place in the main worktree).
set -eu
NAME=${1:?usage: bench.sh <name> <web-port> <mock-port> [start|stop|reset|status]}
WEB_PORT=${2:?usage: bench.sh <name> <web-port> <mock-port> [start|stop|reset|status]}
MOCK_PORT=${3:?usage: bench.sh <name> <web-port> <mock-port> [start|stop|reset|status]}
ACTION=${4:-start}
case "$NAME" in *[!a-z0-9-]*|'') echo "bench name must match [a-z0-9-]+" >&2; exit 1 ;; esac
if [ "$WEB_PORT" = 3080 ]; then echo "port 3080 belongs to the real service" >&2; exit 1; fi

PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$PLUGIN")"
HOME_DIR="$ROOT/.dsh-test-$NAME"
if [ -z "${DSH_HARNESS:-}" ]; then
  DSH_HARNESS="$ROOT/deepseek-harness"
  if [ ! -d "$DSH_HARNESS" ]; then
    MAIN="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")/$(git -C "$ROOT" rev-parse --show-prefix)"
    DSH_HARNESS="${MAIN%/}/deepseek-harness"
  fi
  [ -d "$DSH_HARNESS" ] || DSH_HARNESS="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")/deepseek-harness"
fi

alive() { [ -f "$HOME_DIR/$1.pid" ] && kill -0 "-$(cat "$HOME_DIR/$1.pid")" 2>/dev/null; }

# Each process runs in its own session (setsid), so its pid is also its process group, which
# outlives it: pnpm exits before the dsh it started. dash's kill takes no `--`.
stop_one() {
  file="$HOME_DIR/$1.pid"
  [ -f "$file" ] || return 0
  pid=$(cat "$file")
  kill -TERM "-$pid" 2>/dev/null || true
  i=0
  while kill -0 "-$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  kill -KILL "-$pid" 2>/dev/null || true
  rm -f "$file"
}

ensure_profile() {
  profile="$HOME_DIR/profiles/web"
  if [ -f "$profile/package.json" ] && grep -q "\"link:$PLUGIN\"" "$profile/package.json"; then return 0; fi
  mkdir -p "$profile"
  cat > "$profile/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": { "ds-bot": "link:$PLUGIN" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "ds-bot"] } }
}
EOF
  printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$profile/pnpm-workspace.yaml"
  (cd "$profile" && DSH_HOME="$HOME_DIR" pnpm install >/dev/null)
}

# Bench-only plugin config, layered over the profile with --patch.
write_overlay() {
  overlay="$HOME_DIR/bench.patch.yml"
  printf '[]\n' > "$overlay"
  if [ -n "${CHECK_RATIO:-}" ]; then
    printf -- '- id: bot\n  config:\n    checkRatio: %s\n' "$CHECK_RATIO" > "$overlay"
  fi
  if [ -n "${CONTEXT_WINDOW:-}" ]; then
    [ -n "${CHECK_RATIO:-}" ] || : > "$overlay"
    {
      printf -- '- id: llm-deepseek\n  config:\n    models:\n'
      printf -- '      - { id: deepseek-flash, contextWindow: %s, maxTokens: 8000, inputModalities: [text, image] }\n' "$CONTEXT_WINDOW"
      printf -- '      - { id: deepseek-v4-pro, contextWindow: %s, maxTokens: 8000 }\n' "$CONTEXT_WINDOW"
    } >> "$overlay"
  fi
}

start() {
  mkdir -p "$HOME_DIR"
  ensure_profile
  write_overlay
  if ! alive mock; then
    (cd "$PLUGIN" && MOCK_PORT="$MOCK_PORT" MOCK_DELAY_MS="${MOCK_DELAY_MS:-300}" MOCK_LOG="$HOME_DIR/mock.jsonl" \
      setsid node dev/mock-llm.mjs "$HOME_DIR" </dev/null >"$HOME_DIR/mock.out" 2>&1 & echo $! >"$HOME_DIR/mock.pid")
  fi
  if ! alive web; then
    log="$HOME_DIR/web.log"
    rm -f "$log"
    (cd "$DSH_HARNESS" && DSH_HOME="$HOME_DIR" DEEPSEEK_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" DEEPSEEK_API_KEY=mock-key \
      setsid pnpm -s dsh --profile web --patch apps/web/tests/pin-browse-picker.overlay.yml --patch "$HOME_DIR/bench.patch.yml" \
      --no-open --port "$WEB_PORT" </dev/null >"$log" 2>&1 & echo $! >"$HOME_DIR/web.pid")
    i=0
    until grep -q "dsh web: http" "$log" 2>/dev/null; do
      i=$((i + 1))
      if [ $i -gt 120 ] || ! alive web; then echo "dsh web did not start; see $log" >&2; tail -20 "$log" | grep -v 'token=' >&2; exit 1; fi
      sleep 1
    done
  fi
  status
}

status() {
  for name in mock web; do
    if alive $name; then echo "$name: running (pid $(cat "$HOME_DIR/$name.pid"))"; else echo "$name: stopped"; fi
  done
  echo "home: $HOME_DIR  web: http://127.0.0.1:$WEB_PORT  mock: $MOCK_PORT"
}

case "$ACTION" in
  start) start ;;
  stop) stop_one web; stop_one mock; status ;;
  reset)
    stop_one web
    stop_one mock
    rm -f "$HOME_DIR/mock.jsonl" "$HOME_DIR/cookies.txt"
    rm -rf "$HOME_DIR/bot" "$HOME_DIR"/sessions/*workspace*/session-*
    start
    ;;
  status) status ;;
  *) echo "unknown action $ACTION" >&2; exit 1 ;;
esac
