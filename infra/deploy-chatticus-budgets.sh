#!/bin/sh
# Deploy ChatticusBudgets only. Never --all. Never snapshots, computers, or thin-turn.
# Requires both CHATTICUS_BUDGETS_* env vars; never deploys without CDK budget context.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-budgets.sh" >&2
  exit 2
fi

unset AWS_PROFILE || true

if [ -z "${CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD:-}" ] ||
  [ -z "${CHATTICUS_BUDGETS_NOTIFICATION_EMAIL:-}" ]; then
  echo "CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD and CHATTICUS_BUDGETS_NOTIFICATION_EMAIL are required." >&2
  echo "Set both before deploy. Do not invent defaults." >&2
  exit 1
fi

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusBudgets deploy." >&2
  exit 1
fi

# shellcheck source=budgets-deploy-context.sh
. "$(dirname "$0")/budgets-deploy-context.sh"

# shellcheck disable=SC2086
npx cdk deploy ChatticusBudgets --require-approval never ${BUDGETS_CDK_CONTEXT}

echo ""
echo "OpenAI hard spend caps are console-only; set them by hand on the vendor project."
echo "Confirm the SNS email subscription for ${CHATTICUS_BUDGETS_NOTIFICATION_EMAIL} after deploy."
