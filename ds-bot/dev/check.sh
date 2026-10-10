#!/bin/sh
# One-command check of this checkout on both ends, with the mock model only:
#   unit     npm test
#   build    client.js matches src/client (build-client.mjs --check)
#   lint     npm run lint (warnings do not fail)
#   smoke    a fresh smoke bench and dev/smoke.mjs
#   web      a fresh Web bench and dev/ui-shots.mjs (sidebar, private chat, group, settings)
#   desktop  a fresh Desktop (desktop-linux/desktop.sh), the same shots, browser-check.mjs,
#            and read-check.mjs on the sample pages (dev/read-pages.mjs on 88n4)
# Every process it starts is stopped at the end, also on failure or Ctrl-C.
#
#   dev/check.sh [--skip step,step] [--only step,step] [--out <dir>]
#
# Screenshots and logs go to --out (default: shots/check-<YYYYMMDD-HHMM> beside ds-bot/ in
# the main worktree).
# Ports follow SLOT=n (0-9, default 0): Web 31n0/88n0, smoke 31n1/88n1, and the Desktop
# ports of desktop.sh. Bench data: <checkout>/.dsh-test-check-web, -check-smoke and
# .dsh-test-desktop-check. Web shots need Chrome or Chromium (CHROME_BIN, see ui-shots.mjs);
# the Desktop step needs xvfb-run and ffmpeg and about 1 GB of memory.
set -u
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$PLUGIN")"
MAIN="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")/$(git -C "$ROOT" rev-parse --show-prefix)"
MAIN="${MAIN%/}"
SLOT=${SLOT:-0}
case "$SLOT" in [0-9]) ;; *) echo "SLOT must be one digit" >&2; exit 2 ;; esac
STEPS="unit build lint smoke web desktop"
SKIP=""
ONLY=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip) SKIP=$(echo "$2" | tr ',' ' '); shift 2 ;;
    --only) ONLY=$(echo "$2" | tr ',' ' '); shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done
for step in $SKIP $ONLY; do
  case " $STEPS " in *" $step "*) ;; *) echo "unknown step $step; steps: $STEPS" >&2; exit 2 ;; esac
done
OUT=${OUT:-"$MAIN/shots/check-$(date +%Y%m%d-%H%M)"}
mkdir -p "$OUT/logs"
OUT="$(cd "$OUT" && pwd)"

if [ -z "${DSH_HARNESS:-}" ]; then
  DSH_HARNESS="$ROOT/deepseek-harness"
  [ -d "$DSH_HARNESS" ] || DSH_HARNESS="$MAIN/deepseek-harness"
  [ -d "$DSH_HARNESS" ] || DSH_HARNESS="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")/deepseek-harness"
fi
export DSH_HARNESS
WEB_PORT=31${SLOT}0 WEB_MOCK=88${SLOT}0 SMOKE_PORT=31${SLOT}1 SMOKE_MOCK=88${SLOT}1
DESKTOP="$PLUGIN/dev/desktop-linux/desktop.sh"

cleanup() {
  "$PLUGIN/dev/bench.sh" check-smoke "$SMOKE_PORT" "$SMOKE_MOCK" stop >/dev/null 2>&1
  "$PLUGIN/dev/bench.sh" check-web "$WEB_PORT" "$WEB_MOCK" stop >/dev/null 2>&1
  SLOT=$SLOT "$DESKTOP" check stop >/dev/null 2>&1
  pages="$ROOT/.dsh-test-desktop-check/read-pages.pid"
  if [ -f "$pages" ]; then kill -TERM "-$(cat "$pages")" 2>/dev/null; rm -f "$pages"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

wanted() {
  if [ -n "$ONLY" ]; then case " $ONLY " in *" $1 "*) ;; *) return 1 ;; esac; fi
  case " $SKIP " in *" $1 "*) return 1 ;; esac
  return 0
}

port_free() { ! node -e "const s=require('net').connect($1,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))"; }
# One retry: on this shared server a bench's dsh web once exited at start with an empty log
# while other sessions used the same dsh checkout, and the next start worked.
bench_reset() {
  dev/bench.sh "$@" reset && return 0
  echo "bench $1 did not start; retrying once"
  dev/bench.sh "$@" reset
}
need_ports() {
  for port in "$@"; do
    port_free "$port" || { echo "port $port is in use; stop what holds it or pick another SLOT" >&2; return 1; }
  done
}

step_unit() { cd "$PLUGIN" && npm test; }
step_build() { cd "$PLUGIN" && node scripts/build-client.mjs --check; }
step_lint() { cd "$PLUGIN" && npm run lint; }
step_smoke() {
  cd "$PLUGIN" || return 1
  dev/bench.sh check-smoke "$SMOKE_PORT" "$SMOKE_MOCK" stop >/dev/null
  need_ports "$SMOKE_PORT" "$SMOKE_MOCK" || return 1
  export CONTEXT_WINDOW=100000 CHECK_RATIO=0.45
  bench_reset check-smoke "$SMOKE_PORT" "$SMOKE_MOCK" || return 1
  node dev/smoke.mjs check-smoke "$SMOKE_PORT"
  status=$?
  dev/bench.sh check-smoke "$SMOKE_PORT" "$SMOKE_MOCK" stop
  return $status
}
step_web() {
  cd "$PLUGIN" || return 1
  dev/bench.sh check-web "$WEB_PORT" "$WEB_MOCK" stop >/dev/null
  need_ports "$WEB_PORT" "$WEB_MOCK" || return 1
  bench_reset check-web "$WEB_PORT" "$WEB_MOCK" || return 1
  node dev/ui-shots.mjs web "$DSH_HARNESS" "$OUT" check-web "$WEB_PORT"
  status=$?
  dev/bench.sh check-web "$WEB_PORT" "$WEB_MOCK" stop
  return $status
}
step_desktop() {
  cd "$PLUGIN" || return 1
  SLOT=$SLOT "$DESKTOP" check stop >/dev/null
  SLOT=$SLOT "$DESKTOP" check reset || return 1
  home="$ROOT/.dsh-test-desktop-check"
  . "$home/desktop.env"
  status=0
  SHOT_DISPLAY=":$DISPLAY_NUM" XAUTHORITY="$home/.xauth" node dev/ui-shots.mjs desktop "$DSH_HARNESS" "$OUT" "$RENDERER_PORT" || status=1
  mkdir -p "$OUT/desktop-browser"
  SHOT_DISPLAY=":$DISPLAY_NUM" XAUTHORITY="$home/.xauth" COOKIE_PORT="$COOKIE_PORT" \
    node dev/desktop-linux/browser-check.mjs "$DSH_HARNESS" "$OUT/desktop-browser" "$RENDERER_PORT" || status=1
  # The reader check on the sample pages only (--offline): real sites change under it.
  pages_port=88${SLOT}4
  if need_ports "$pages_port"; then
    setsid node dev/read-pages.mjs "$pages_port" </dev/null >"$home/read-pages.log" 2>&1 &
    echo $! >"$home/read-pages.pid"
    sleep 1
    SHOT_DISPLAY=":$DISPLAY_NUM" XAUTHORITY="$home/.xauth" \
      node dev/desktop-linux/read-check.mjs "$DSH_HARNESS" "$OUT/desktop-read" "$RENDERER_PORT" "$pages_port" Chief --offline || status=1
    kill -TERM "-$(cat "$home/read-pages.pid")" 2>/dev/null
    rm -f "$home/read-pages.pid"
  else
    status=1
  fi
  SLOT=$SLOT "$DESKTOP" check stop
  return $status
}

SUMMARY=""
FAILED=""
TOTAL_START=$(date +%s)
for step in $STEPS; do
  if ! wanted "$step"; then
    SUMMARY="$SUMMARY$(printf '%-8s skipped' "$step")
"
    continue
  fi
  log="$OUT/logs/$step.log"
  printf '== %-8s ' "$step"
  start=$(date +%s)
  # A subshell keeps each step's cd to itself; login token URLs stay out of the logs.
  ( "step_$step" ) >"$log.raw" 2>&1 </dev/null
  status=$?
  grep -v 'token=' "$log.raw" >"$log"
  rm -f "$log.raw"
  elapsed=$(( $(date +%s) - start ))
  if [ $status -eq 0 ]; then result=ok; else result=FAILED; FAILED="$FAILED $step"; fi
  echo "$result (${elapsed} s)"
  if [ $status -ne 0 ]; then
    echo "   log: $log"
    tail -15 "$log" | sed 's/^/   | /'
  fi
  SUMMARY="$SUMMARY$(printf '%-8s %-7s %4s s  %s' "$step" "$result" "$elapsed" "$log")
"
done

echo
printf '%s' "$SUMMARY"
echo "total $(( $(date +%s) - TOTAL_START )) s; screenshots: $OUT"
if [ -n "$FAILED" ]; then
  echo "check failed:$FAILED"
  exit 1
fi
echo "check passed"
