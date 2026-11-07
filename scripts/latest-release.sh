#!/usr/bin/env bash
# Prints the newest Obzly release tag (vX.Y.Z) on github.com/obzly/obzly.
set -euo pipefail
git ls-remote --tags --refs https://github.com/obzly/obzly.git 'v*' |
  sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1
