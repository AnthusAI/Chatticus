#!/bin/sh
# Deploy ChatticusSnapshots only. Never --all. Never computers or thin-turn.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-snapshots.sh" >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusSnapshots deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusSnapshots --require-approval never

echo ""
echo "OpenAI hard spend caps are console-only; set them by hand on the vendor project."
