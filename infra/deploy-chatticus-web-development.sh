#!/bin/sh
# Deploy ChatticusWeb only (dev.chattic.us). --exclusively skips ChatticusThinTurn
# and ChatticusDns despite web.addDependency in bin/chatticus.ts.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-web-development.sh" >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusWeb deploy." >&2
  exit 1
fi

npx cdk deploy ChatticusWeb --exclusively --require-approval never

DISTRIBUTION_ID="$(
  aws ssm get-parameter \
    --name '/chatticus/development/web/cloudfront-distribution-id' \
    --query 'Parameter.Value' \
    --output text
)"
if [ -z "${DISTRIBUTION_ID}" ]; then
  echo "missing /chatticus/development/web/cloudfront-distribution-id in SSM" >&2
  exit 1
fi

aws cloudfront create-invalidation \
  --distribution-id "${DISTRIBUTION_ID}" \
  --paths "/*"
