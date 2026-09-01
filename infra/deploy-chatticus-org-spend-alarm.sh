#!/bin/sh
# Deploy only the account-level org spend alarm stack. Never --all. Never
# computers, snapshots, or thin-turn stacks. Requires the human to set the
# monthly limit and notification email; refuses invented defaults.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-org-spend-alarm.sh" >&2
  echo "Refuses extra arguments." >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusOrgSpendAlarm deploy." >&2
  exit 1
fi

MONTHLY_USD="${CHATTICUS_ORG_SPEND_MONTHLY_USD:-}"
NOTIFICATION_EMAIL="${CHATTICUS_ORG_SPEND_NOTIFICATION_EMAIL:-}"

if [ -z "${MONTHLY_USD}" ] || [ -z "${NOTIFICATION_EMAIL}" ]; then
  echo "CHATTICUS_ORG_SPEND_MONTHLY_USD and CHATTICUS_ORG_SPEND_NOTIFICATION_EMAIL are required." >&2
  echo "Set both before deploying ChatticusOrgSpendAlarm. Do not invent defaults." >&2
  exit 1
fi

case "${MONTHLY_USD}" in
  *[!0-9.]*|'')
    echo "CHATTICUS_ORG_SPEND_MONTHLY_USD must be a positive number, got: ${MONTHLY_USD}" >&2
    exit 1
    ;;
esac

if ! python3 -c "import sys; v=float(sys.argv[1]); sys.exit(0 if v > 0 else 1)" "${MONTHLY_USD}"; then
  echo "CHATTICUS_ORG_SPEND_MONTHLY_USD must be a positive number, got: ${MONTHLY_USD}" >&2
  exit 1
fi

if ! printf '%s' "${NOTIFICATION_EMAIL}" | grep -q '@'; then
  echo "CHATTICUS_ORG_SPEND_NOTIFICATION_EMAIL must be an email address." >&2
  exit 1
fi

npx cdk deploy ChatticusOrgSpendAlarm --require-approval never \
  -c "orgSpendMonthlyUsd=${MONTHLY_USD}" \
  -c "orgSpendNotificationEmail=${NOTIFICATION_EMAIL}"

echo ""
echo "OpenAI hard spend caps are console-only; set them by hand on the vendor project."
echo "Confirm the SNS email subscription for ${NOTIFICATION_EMAIL} after deploy."
