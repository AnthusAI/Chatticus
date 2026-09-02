#!/bin/sh
# Deploy ChatticusAuthStaging only (auth-staging.chattic.us). --exclusively skips sibling stacks.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-auth-staging.sh" >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusAuthStaging deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusAuthStaging --exclusively --require-approval never
