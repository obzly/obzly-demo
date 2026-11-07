#!/usr/bin/env bash
# Adds the demo to an Obzly checkout: src/ becomes frontend/src/demo, plus the
# demo's Vite config, env file and DuckDB (SQL mode), which isn't saved to
# package.json. Run `npm ci` in frontend/ first.
#
#   scripts/setup.sh <obzly checkout>          copy (CI, tests, type check)
#   scripts/setup.sh <obzly checkout> --link   symlink, for `npm run dev` edits
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
frontend="$(cd "${1:?usage: scripts/setup.sh <obzly checkout> [--link]}" && pwd)/frontend"
[ -f "$frontend/src/main.tsx" ] || { echo "no frontend/src/main.tsx under $1" >&2; exit 1; }

rm -rf "$frontend/src/demo"
if [ "${2:-}" = "--link" ]; then
  ln -s "$here/src" "$frontend/src/demo"
else
  cp -R "$here/src" "$frontend/src/demo"
fi
cp "$here/build/vite.demo.config.ts" "$here/build/.env.demo" "$frontend/"

cd "$frontend"
if ! npm ls @duckdb/duckdb-wasm >/dev/null 2>&1; then
  npm install --no-save --no-audit --no-fund @duckdb/duckdb-wasm@1.32.0
fi
