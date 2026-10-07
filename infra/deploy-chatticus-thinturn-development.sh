#!/bin/sh
# Deploy only the development thin-turn stack. Never --all. Never snapshots
# or computers. Staging and production are different scripts/commands.
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" != "" ]; then
  echo "usage: sh deploy-chatticus-thinturn-development.sh" >&2
  echo "Refuses extra arguments so this cannot be used for staging or production." >&2
  exit 2
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before ChatticusThinTurn deploy." >&2
  exit 1
fi

# Budget rollup: sets BUDGETS_CDK_CONTEXT only when both budget env vars are set,
# refuses partial config, and adds nothing when neither is set.
# shellcheck source=budgets-deploy-context.sh
. ./budgets-deploy-context.sh

# shellcheck disable=SC2086
npx cdk deploy ChatticusThinTurn --exclusively --require-approval never ${BUDGETS_CDK_CONTEXT}
