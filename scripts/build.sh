#!/usr/bin/env bash
# Builds the demo site into <obzly checkout>/frontend/dist.
#   scripts/build.sh <obzly checkout> [version shown in the UI]
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
"$here/scripts/setup.sh" "${1:?usage: scripts/build.sh <obzly checkout> [version]}"
frontend="$(cd "$1" && pwd)/frontend"
version="${2:-$(git -C "$frontend" describe --tags --always)}"

cd "$frontend"
VITE_APP_VERSION="$version" npx vite build --config vite.demo.config.ts --mode demo
# GitHub Pages serves 404.html for unknown paths; the app routes them itself.
cp dist/index.html dist/404.html
printf 'obzly %s\ndemo %s\n' "$version" "$(git -C "$here" rev-parse --verify -q HEAD || echo unknown)" \
  > dist/demo-version.txt
