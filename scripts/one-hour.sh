#!/usr/bin/env bash
# One-hour acceptance run: recorder + generator as two processes at default parameters,
# recorder RSS sampled every 10 s, then validate and inspect. Every log lands in one folder.
#
#   bash scripts/one-hour.sh                 # 3600 s, evidence in artifacts/one-hour-<timestamp>/
#   DURATION=60 bash scripts/one-hour.sh     # short rehearsal of the same procedure
#
# The .sigb (1.72 GiB for an hour) goes to $SIGB_DIR, outside the repository.
set -euo pipefail

cd "$(dirname "$0")/.."

DURATION="${DURATION:-3600}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${OUT:-artifacts/one-hour-$STAMP}"
SIGB_DIR="${SIGB_DIR:-${TMPDIR:-/tmp}}"
SIGB="$SIGB_DIR/one-hour-$STAMP.sigb"
SOCK="/tmp/sigacq-one-hour-$$.sock"

mkdir -p "$OUT"
echo "duration ${DURATION}s · evidence → $OUT · recording → $SIGB"

# Keep the machine awake for the whole run (macOS only).
if command -v caffeinate >/dev/null; then
  caffeinate -dimsu -w $$ &
fi

node bin/recorder.ts --out "$SIGB" --socket "$SOCK" \
  --stats-interval 10 --stats-out "$OUT/recorder-stats.ndjson" > "$OUT/recorder.log" 2>&1 &
recorder=$!

# External RSS sampler: epoch seconds, RSS in KiB. The first sample waits for Node to start.
( sleep 1
  while kill -0 "$recorder" 2>/dev/null; do
    echo "$(date +%s) $(ps -o rss= -p "$recorder" | tr -d ' ')"
    sleep 10
  done ) > "$OUT/recorder-rss.txt" &
sampler=$!

trap 'kill -INT "$recorder" 2>/dev/null || true' INT TERM

sleep 2
node bin/generator.ts --socket "$SOCK" --duration "$DURATION" --stats-interval 60 \
  --pacing-out "$OUT/pacing.json" > "$OUT/generator.log" 2>&1

kill -INT "$recorder"
wait "$recorder" || true
kill "$sampler" 2>/dev/null || true

# Peak RSS of the validator: -l on macOS, -v on GNU time.
if /usr/bin/time -l true >/dev/null 2>&1; then timeflag=-l; else timeflag=-v; fi
set +e
/usr/bin/time "$timeflag" node bin/sigval.ts "$SIGB" > "$OUT/validator.txt" 2> "$OUT/validator.stderr"
status=$?
set -e
echo "exit=$status" >> "$OUT/validator.txt"
node bin/sigctl.ts info "$SIGB" > "$OUT/info.txt"
cp "${SIGB%.sigb}.json" "$OUT/recording.json"

awk 'NF==2 && $2>0 { n++; v[n]=$2 }
     END { if (!n) exit; lo=v[1]; hi=v[1]; for (i=1;i<=n;i++) { if (v[i]<lo) lo=v[i]; if (v[i]>hi) hi=v[i] }
           printf "recorder RSS: %d samples, min %.0f MiB, max %.0f MiB\n", n, lo/1024, hi/1024 }' \
  "$OUT/recorder-rss.txt" | tee "$OUT/rss-summary.txt"

echo
cat "$OUT/validator.txt"
grep -v '^{' "$OUT/generator.log" | tail -12
exit "$status"
