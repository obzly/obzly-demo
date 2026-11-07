#!/usr/bin/env bash
# Runs the demo on a dev server, with src/ linked in so edits reload.
#   scripts/dev.sh <obzly checkout> [vite options]
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
"$here/scripts/setup.sh" "${1:?usage: scripts/dev.sh <obzly checkout> [vite options]}" --link
cd "$(cd "$1" && pwd)/frontend"
shift
exec npx vite --config vite.demo.config.ts --mode demo "$@"
