#!/bin/sh
# Deploy ChatticusSnapshots only. Never --all. Never computers or thin-turn.
# Account-level AWS budget is created here when budget env vars are set.
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

# shellcheck source=budgets-deploy-context.sh
. "$(dirname "$0")/budgets-deploy-context.sh"

# shellcheck disable=SC2086
npx cdk deploy ChatticusSnapshots --require-approval never ${BUDGETS_CDK_CONTEXT}

echo ""
echo "OpenAI hard spend caps are console-only; set them by hand on the vendor project."
if [ -n "${CHATTICUS_BUDGETS_NOTIFICATION_EMAIL:-}" ]; then
  echo "Confirm the SNS email subscription for ${CHATTICUS_BUDGETS_NOTIFICATION_EMAIL} after deploy."
fi
