#!/usr/bin/env bash
# Opens The Odyssey in the browser-ready state. Press Record on the page; press Stop when done. The
# recording is verified automatically. Nothing else to run.
#
#   bash scripts/demo.sh            (then open http://localhost:8787)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f ui/dist/bundle.js ]; then
  echo "  building the viewer (one-off)…"
  npm install --silent && npm run ui:build --silent
fi
exec node bin/uiserver.ts "$@"
