#!/bin/sh
# Desktop test bench: the scripted mock model, the cookie test page and the unpackaged dsh
# Desktop (launch.mts) inside its own Xvfb display, on a profile that links the plugin to
# this checkout. Same habits as dev/bench.sh: pid files, process groups, never by name.
#
#   dev/desktop-linux/desktop.sh <name> [start|stop|reset|status]
#
# Data lives in <checkout>/.dsh-test-desktop-<name>; `reset` wipes its Bot team and Sessions
# (keeping the profile, its node_modules and the Electron user data) before starting.
# `start` returns once the window shows the Bot team. Its files are named desktop*, so a
# Web bench (dev/bench.sh desktop-<name> ...) can run on the same data next to it.
#
# Ports and display: SLOT=n (0-9, default 0) gives mock 88n2, cookie page 88n3, renderer /
# main / host debugging ports 95n0 / 95n1 / 95n2 and display :1n. Each can be set on its
# own: MOCK_PORT, COOKIE_PORT, RENDERER_PORT, MAIN_PORT, HOST_PORT, DISPLAY_NUM.
# WINDOW=1400x860 sizes the window after start (WINDOW= keeps dsh's own size).
# Other environment: MOCK_DELAY_MS, DSH_HARNESS (default: beside this checkout, else at the
# same place in the main worktree), DSB_DESKTOP_CACHE (Electron and the Linux runtime; default
# ~/.cache/dsb-desktop), ELECTRON_BIN (default: fetched into the cache).
# One Desktop takes about 1 GB of memory.
set -eu
NAME=${1:?usage: desktop.sh <name> [start|stop|reset|status]}
ACTION=${2:-start}
case "$NAME" in *[!a-z0-9-]*|'') echo "desktop name must match [a-z0-9-]+" >&2; exit 1 ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(cd "$HERE/../.." && pwd)"
ROOT="$(dirname "$PLUGIN")"
HOME_DIR="$ROOT/.dsh-test-desktop-$NAME"
ENV_FILE="$HOME_DIR/desktop.env"
if [ -z "${DSH_HARNESS:-}" ]; then
  DSH_HARNESS="$ROOT/deepseek-harness"
  if [ ! -d "$DSH_HARNESS" ]; then
    MAIN="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")/$(git -C "$ROOT" rev-parse --show-prefix)"
    DSH_HARNESS="${MAIN%/}/deepseek-harness"
  fi
  [ -d "$DSH_HARNESS" ] || DSH_HARNESS="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")/deepseek-harness"
fi
DSH_HARNESS="$(cd "$DSH_HARNESS" && pwd)"

alive() { [ -f "$HOME_DIR/$1.pid" ] && kill -0 "-$(cat "$HOME_DIR/$1.pid")" 2>/dev/null; }
any_alive() { alive desktop || alive desktop-mock || alive desktop-cookie; }

# While anything runs, the ports it was started with win over SLOT and friends.
if [ -f "$ENV_FILE" ] && any_alive; then
  . "$ENV_FILE"
else
  SLOT=${SLOT:-0}
  case "$SLOT" in [0-9]) ;; *) echo "SLOT must be one digit" >&2; exit 1 ;; esac
  MOCK_PORT=${MOCK_PORT:-88${SLOT}2}
  COOKIE_PORT=${COOKIE_PORT:-88${SLOT}3}
  RENDERER_PORT=${RENDERER_PORT:-95${SLOT}0}
  MAIN_PORT=${MAIN_PORT:-95${SLOT}1}
  HOST_PORT=${HOST_PORT:-95${SLOT}2}
  DISPLAY_NUM=${DISPLAY_NUM:-1${SLOT}}
fi
CACHE=${DSB_DESKTOP_CACHE:-$HOME/.cache/dsb-desktop}

# dash's kill takes no `--`. Each process runs in its own session (setsid), so its pid is
# also its process group, which holds Xvfb, Electron and the dsh host as well.
stop_one() {
  file="$HOME_DIR/$1.pid"
  [ -f "$file" ] || return 0
  pid=$(cat "$file")
  kill -TERM "-$pid" 2>/dev/null || true
  i=0
  while kill -0 "-$pid" 2>/dev/null && [ $i -lt 75 ]; do sleep 0.2; i=$((i + 1)); done
  kill -KILL "-$pid" 2>/dev/null || true
  rm -f "$file"
}

port_busy() { node -e "const s=require('net').connect($1,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))"; }

ensure_profile() {
  profile="$HOME_DIR/profiles/desktop"
  mkdir -p "$profile"
  [ -f "$profile/cordis.patch.yml" ] || cp "$HERE/onboarding.patch.yml" "$profile/cordis.patch.yml"
  if [ -f "$profile/package.json" ] && grep -q "\"link:$PLUGIN\"" "$profile/package.json" && [ -d "$profile/node_modules" ]; then return 0; fi
  cat > "$profile/package.json" <<EOF
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": { "ds-bot": "link:$PLUGIN" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "ds-bot"] } }
}
EOF
  printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$profile/pnpm-workspace.yaml"
  (cd "$profile" && DSH_HOME="$HOME_DIR" pnpm install >/dev/null)
}

fail_start() {
  echo "desktop: $1; see $HOME_DIR/desktop.log" >&2
  tail -20 "$HOME_DIR/desktop.log" 2>/dev/null | grep -v 'token=' >&2 || true
  exit 1
}

start() {
  mkdir -p "$HOME_DIR"
  if ! alive desktop; then
    for port in "$MOCK_PORT" "$COOKIE_PORT" "$RENDERER_PORT" "$MAIN_PORT" "$HOST_PORT"; do
      case "$port" in 3080|9422|9429|9430) echo "port $port belongs to another service" >&2; exit 1 ;; esac
    done
    if [ -e "/tmp/.X$DISPLAY_NUM-lock" ]; then echo "display :$DISPLAY_NUM is in use; pick another SLOT or DISPLAY_NUM" >&2; exit 1; fi
    for port in "$RENDERER_PORT" "$MAIN_PORT" "$HOST_PORT"; do
      if port_busy "$port"; then echo "port $port is in use; pick another SLOT" >&2; exit 1; fi
    done
  fi
  ensure_profile
  ELECTRON_BIN=${ELECTRON_BIN:-"$(node "$HERE/fetch-electron.mjs" "$DSH_HARNESS" "$CACHE" | tail -1)/electron"}
  cat > "$ENV_FILE" <<EOF
SLOT=${SLOT:-}
MOCK_PORT=$MOCK_PORT
COOKIE_PORT=$COOKIE_PORT
RENDERER_PORT=$RENDERER_PORT
MAIN_PORT=$MAIN_PORT
HOST_PORT=$HOST_PORT
DISPLAY_NUM=$DISPLAY_NUM
EOF
  if ! alive desktop-mock; then
    (cd "$PLUGIN" && MOCK_PORT="$MOCK_PORT" MOCK_DELAY_MS="${MOCK_DELAY_MS:-300}" MOCK_LOG="$HOME_DIR/desktop-mock.jsonl" \
      setsid node dev/mock-llm.mjs </dev/null >"$HOME_DIR/desktop-mock.log" 2>&1 & echo $! >"$HOME_DIR/desktop-mock.pid")
  fi
  if ! alive desktop-cookie; then
    (setsid node "$HERE/cookie-page.mjs" "$COOKIE_PORT" </dev/null >"$HOME_DIR/desktop-cookie.log" 2>&1 & echo $! >"$HOME_DIR/desktop-cookie.pid")
  fi
  if ! alive desktop; then
    rm -f "$HOME_DIR/desktop.log"
    (cd "$HERE" && DSH_REPO="$DSH_HARNESS" DSH_HOME="$HOME_DIR" ELECTRON_BIN="$ELECTRON_BIN" DSB_DESKTOP_CACHE="$CACHE" \
      DEEPSEEK_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" DEEPSEEK_API_KEY=mock-key \
      DSH_DESKTOP_RENDERER_DEBUG_PORT="$RENDERER_PORT" DSH_DESKTOP_MAIN_INSPECT_PORT="$MAIN_PORT" DSH_DESKTOP_HOST_INSPECT_PORT="$HOST_PORT" \
      setsid xvfb-run -n "$DISPLAY_NUM" -f "$HOME_DIR/.xauth" -s "-screen 0 1440x900x24" "$DSH_HARNESS/node_modules/.bin/tsx" launch.mts \
      </dev/null >"$HOME_DIR/desktop.log" 2>&1 & echo $! >"$HOME_DIR/desktop.pid")
    sleep 2
    alive desktop || fail_start "Desktop exited at once"
    node "$HERE/wait-app.mjs" "$DSH_HARNESS" "$RENDERER_PORT" "${DESKTOP_TIMEOUT:-240}" >"$HOME_DIR/wait.log" 2>&1 || fail_start "the window did not show the Bot team ($(tail -1 "$HOME_DIR/wait.log"))"
    window=${WINDOW-1400x860}
    if [ -n "$window" ]; then
      node "$HERE/window-size.mjs" "${window%x*}" "${window#*x}" "$MAIN_PORT" >/dev/null || fail_start "could not size the window"
    fi
  fi
  status
}

status() {
  for name in desktop-mock desktop-cookie desktop; do
    if alive $name; then echo "$name: running (pid $(cat "$HOME_DIR/$name.pid"))"; else echo "$name: stopped"; fi
  done
  echo "home: $HOME_DIR"
  echo "mock: $MOCK_PORT  cookie page: http://localhost:$COOKIE_PORT/  debugging: renderer $RENDERER_PORT, main $MAIN_PORT, host $HOST_PORT"
  echo "display: :$DISPLAY_NUM  for screen grabs: SHOT_DISPLAY=:$DISPLAY_NUM XAUTHORITY=$HOME_DIR/.xauth"
  echo "dsh: $DSH_HARNESS"
}

case "$ACTION" in
  start) start ;;
  stop) stop_one desktop; stop_one desktop-cookie; stop_one desktop-mock; status ;;
  reset)
    stop_one desktop
    stop_one desktop-cookie
    stop_one desktop-mock
    rm -f "$HOME_DIR/desktop-mock.jsonl"
    rm -rf "$HOME_DIR/bot" "$HOME_DIR"/sessions/*workspace*/session-*
    start
    ;;
  status) status ;;
  *) echo "unknown action $ACTION" >&2; exit 1 ;;
esac
