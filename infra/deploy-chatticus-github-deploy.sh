#!/bin/sh
# One-time (or rare) deploy of the GitHub Actions OIDC deploy role. Never --all.
set -eu

cd "$(dirname "$0")"

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusGitHubDeploy deploy." >&2
  exit 1
fi

# shellcheck source=budgets-deploy-context.sh
. "$(dirname "$0")/budgets-deploy-context.sh"

# shellcheck disable=SC2086
npx cdk deploy ChatticusGitHubDeploy --require-approval never ${BUDGETS_CDK_CONTEXT}
