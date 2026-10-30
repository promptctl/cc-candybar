#!/bin/sh
# Builds the landscape page into ../site: export the survey's data and bar bundles, then bundle the
# app. Run from anywhere; everything it needs is read from the survey directory in /tmp/ccland.
set -eu
cd "$(dirname "$0")"
python3 -I ../tools/export.py src/data.json public
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
echo "page: $(cd ../site && pwd)/index.html"
