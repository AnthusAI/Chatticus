#!/bin/sh
# Deploy ChatticusAuthProduction only (auth.chattic.us). --exclusively skips sibling stacks.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-auth-production.sh" >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusAuthProduction deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusAuthProduction --exclusively --require-approval never
