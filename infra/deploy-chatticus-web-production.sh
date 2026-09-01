#!/bin/sh
# Deploy ChatticusWebProduction only (CloudFront enabled flag); does not restack ThinTurn.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-web-production.sh" >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusWebProduction deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusWebProduction --require-approval never
