#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node scripts/make-seamed-executor.mjs > /dev/null
rm -rf dist
mkdir -p dist
BANNER="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
for entry in owner-raw owner-executor; do
	../../node_modules/.bin/esbuild "src/$entry.ts" --bundle --platform=node --format=esm --target=node22 \
		--banner:js="$BANNER" --outfile="dist/$entry.mjs" --log-level=warning
done
ls -l dist
