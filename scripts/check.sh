#!/usr/bin/env bash
# Type checks, lints and tests the demo inside an Obzly checkout, with the
# app's own TypeScript, ESLint and Prettier settings.
#   scripts/check.sh <obzly checkout>
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
"$here/scripts/setup.sh" "${1:?usage: scripts/check.sh <obzly checkout>}"
cd "$(cd "$1" && pwd)/frontend"

npx tsc -b
npx eslint src/demo vite.demo.config.ts
npx prettier --check "src/demo/**/*.{ts,js}" vite.demo.config.ts
npx vitest run src/demo
