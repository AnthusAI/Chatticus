#!/bin/sh
# Generate Markus wiki HTML for the Next.js export.
# Prefer a live publish; if Python/Markus is missing (CDK Docker fallback),
# reuse pages already written onto the asset by the deploy workflow.
set -eu

cd "$(dirname "$0")/.."

if python3 -m chatticus.wiki_publish; then
  exit 0
fi

if [ -f generated/wiki/pages.json ]; then
  echo "wiki_publish unavailable; using existing generated/wiki/pages.json" >&2
  exit 0
fi

echo "python3 -m chatticus.wiki_publish failed and generated/wiki/pages.json is missing." >&2
exit 1
