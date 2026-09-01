#!/bin/sh
# Deploy ChatticusWebStaging only (CloudFront enabled flag). --exclusively skips
# ChatticusThinTurnStaging and ChatticusDns despite web.addDependency in bin/chatticus.ts.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-web-staging.sh" >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusWebStaging deploy." >&2
  exit 1
fi

# shellcheck source=budgets-deploy-context.sh
. "$(dirname "$0")/budgets-deploy-context.sh"

# shellcheck disable=SC2086
npx cdk deploy ChatticusWebStaging --exclusively --require-approval never ${BUDGETS_CDK_CONTEXT}
