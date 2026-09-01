#!/bin/sh
# Set BUDGETS_CDK_CONTEXT for CDK deploy when budget env vars are set.
# Source only from deploy-chatticus-budgets.sh. Refuses partial config and invented defaults.
set -eu

MONTHLY_USD="${CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD:-}"
NOTIFICATION_EMAIL="${CHATTICUS_BUDGETS_NOTIFICATION_EMAIL:-}"

if [ -z "${MONTHLY_USD}" ] && [ -z "${NOTIFICATION_EMAIL}" ]; then
  BUDGETS_CDK_CONTEXT=""
  return 0 2>/dev/null || exit 0
fi

if [ -z "${MONTHLY_USD}" ] || [ -z "${NOTIFICATION_EMAIL}" ]; then
  echo "CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD and CHATTICUS_BUDGETS_NOTIFICATION_EMAIL are required together." >&2
  echo "Set both or neither. Do not invent defaults." >&2
  return 1 2>/dev/null || exit 1
fi

case "${MONTHLY_USD}" in
  *[!0-9.]*|'')
    echo "CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD must be a positive number, got: ${MONTHLY_USD}" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

if ! python3 -c "import sys; v=float(sys.argv[1]); sys.exit(0 if v > 0 else 1)" "${MONTHLY_USD}"; then
  echo "CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD must be a positive number, got: ${MONTHLY_USD}" >&2
  return 1 2>/dev/null || exit 1
fi

if ! printf '%s' "${NOTIFICATION_EMAIL}" | grep -q '@'; then
  echo "CHATTICUS_BUDGETS_NOTIFICATION_EMAIL must be an email address." >&2
  return 1 2>/dev/null || exit 1
fi

BUDGETS_CDK_CONTEXT="-c budgetsMonthlyLimitUsd=${MONTHLY_USD} -c budgetsNotificationEmail=${NOTIFICATION_EMAIL}"
return 0 2>/dev/null || exit 0
