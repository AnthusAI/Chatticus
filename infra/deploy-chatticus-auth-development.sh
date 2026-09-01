#!/bin/sh
# Deploy ChatticusAuth only (auth-dev.chattic.us). --exclusively skips sibling stacks.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-auth-development.sh" >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusAuth deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusAuth --exclusively --require-approval never
