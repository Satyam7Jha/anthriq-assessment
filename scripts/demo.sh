#!/usr/bin/env bash
# One-command demo: starts the recorder, the generator and the read-only viewer, waits for you to
# look at it, then shuts everything down cleanly and validates what was recorded.
#
#   bash scripts/demo.sh [duration_seconds]     (default 300)
#
# Ctrl-C at any point shuts down cleanly: the recorder finalises its header, writes its trailer and
# sidecar, and the recording stays valid.

set -uo pipefail
cd "$(dirname "$0")/.."

DURATION="${1:-300}"
OUT="${SIGACQ_OUT:-/tmp/sigacq-demo.sigb}"
SOCK="/tmp/sigacq-demo.sock"
STATS="${OUT%.sigb}.stats.ndjson"
PORT="${SIGACQ_PORT:-8787}"

REC_PID=""; GEN_PID=""; UI_PID=""

cleanup() {
  echo ""
  echo "  shutting down…"
  # Generator first: it is the producer, and stopping it lets the recorder drain naturally.
  [ -n "$GEN_PID" ] && kill "$GEN_PID" 2>/dev/null
  sleep 0.5
  # SIGINT, not SIGKILL: this is the clean-shutdown path that finalises the header and writes the
  # trailer and sidecar. Give it time to do that.
  [ -n "$REC_PID" ] && kill -INT "$REC_PID" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$REC_PID" 2>/dev/null || break; sleep 0.1; done
  [ -n "$UI_PID" ] && kill "$UI_PID" 2>/dev/null
  rm -f "$SOCK"

  if [ -f "$OUT" ]; then
    echo ""
    echo "  ── verification ─────────────────────────────────────────"
    node bin/sigval.js "$OUT"
    echo "  exit status: $?"
    echo ""
    echo "  recording:  $OUT"
    echo "  sidecar:    ${OUT%.sigb}.json"
    echo ""
    echo "  inspect it:  node bin/sigctl.js info $OUT"
    echo "  read it:     node bin/sigctl.js read $OUT --from 5s --to 6s --channels 3,17"
    echo "  view it:     node bin/uiserver.js --follow $OUT"
  fi
  exit 0
}
trap cleanup INT TERM

rm -f "$OUT" "${OUT%.sigb}.json" "$STATS" "$SOCK"

if [ ! -f ui/dist/bundle.js ]; then
  echo "  building the UI bundle (one-off)…"
  npm install --silent && npm run ui:build --silent
fi

echo "  starting recorder  (PROCESS B — owns the socket and the file)"
node bin/recorder.js --out "$OUT" --socket "$SOCK" --stats-interval 1 --stats-out "$STATS" --quiet &
REC_PID=$!
sleep 1

echo "  starting generator (PROCESS A — paced against a monotonic clock)"
node bin/generator.js --socket "$SOCK" --duration "$DURATION" --stats-interval 10 --quiet &
GEN_PID=$!
sleep 0.5

echo "  starting viewer    (PROCESS E — opens the file O_RDONLY, cannot affect acquisition)"
node bin/uiserver.js --follow "$OUT" --port "$PORT" --stats "$STATS" 2>/dev/null &
UI_PID=$!
sleep 2

echo ""
echo "  ┌────────────────────────────────────────────────────────┐"
echo "  │  open  http://localhost:$PORT                            │"
echo "  └────────────────────────────────────────────────────────┘"
echo ""
echo "  three separate processes:  recorder $REC_PID · generator $GEN_PID · viewer $UI_PID"
echo "  recording for ${DURATION}s — press Ctrl-C any time to stop cleanly and verify"
echo ""

wait "$GEN_PID" 2>/dev/null
echo "  generator finished its ${DURATION}s run"
cleanup
