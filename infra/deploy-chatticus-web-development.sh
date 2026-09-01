#!/bin/sh
# Deploy development thin-turn then the unified web stack for dev.chattic.us.
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

sh deploy-chatticus-thinturn-development.sh

# shellcheck source=budgets-deploy-context.sh
. "$(dirname "$0")/budgets-deploy-context.sh"

# shellcheck disable=SC2086
npx cdk deploy ChatticusWeb --require-approval never ${BUDGETS_CDK_CONTEXT}
