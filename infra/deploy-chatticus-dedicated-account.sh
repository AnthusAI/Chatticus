#!/bin/sh
# Deploy ONE stack of ONE environment into its dedicated account. Never --all.
# Run with that environment account's credentials, never the legacy account's.
set -eu

cd "$(dirname "$0")"

usage() {
  echo "usage: sh deploy-chatticus-dedicated-account.sh development|staging|production STACK" >&2
  echo "STACK: budgets snapshots computers zones certificates thin-turn control-plane web auth" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
case "$1" in
  development | staging | production) ENVIRONMENT="$1" ;;
  *) usage ;;
esac

case "$ENVIRONMENT:$2" in
  *:budgets) STACK="ChatticusBudgets" ;;
  *:snapshots) STACK="ChatticusSnapshots" ;;
  *:computers) STACK="ChatticusComputers" ;;
  *:zones) STACK="ChatticusEnvironmentZones" ;;
  *:certificates) STACK="ChatticusEnvironmentCertificates" ;;
  development:thin-turn) STACK="ChatticusThinTurn" ;;
  development:control-plane) STACK="ChatticusControlPlane" ;;
  development:web) STACK="ChatticusWeb" ;;
  development:auth) STACK="ChatticusAuth" ;;
  staging:thin-turn) STACK="ChatticusThinTurnStaging" ;;
  staging:control-plane) STACK="ChatticusControlPlaneStaging" ;;
  staging:web) STACK="ChatticusWebStaging" ;;
  staging:auth) STACK="ChatticusAuthStaging" ;;
  production:thin-turn) STACK="ChatticusThinTurnProduction" ;;
  production:control-plane) STACK="ChatticusControlPlaneProduction" ;;
  production:web) STACK="ChatticusWebProduction" ;;
  production:auth) STACK="ChatticusAuthProduction" ;;
  *) usage ;;
esac

INTEGRATION_TEST_CDK_CONTEXT=""
if [ "${ENVIRONMENT}" = "development" ] && [ "${STACK}" = "ChatticusControlPlane" ] && [ -n "${CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN:-}" ]; then
  if ! printf '%s' "${CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN}" | grep -Eq '^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$'; then
    echo "CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN must be an IAM role ARN (arn:aws:iam::<12 digits>:role/...)." >&2
    exit 1
  fi
  INTEGRATION_TEST_CDK_CONTEXT="-c integrationTestAllowedRoleArn=${CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN}"
fi

unset AWS_PROFILE || true

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before a dedicated-account deploy." >&2
  exit 1
fi

if aws cloudformation describe-stacks --stack-name ChatticusDns >/dev/null 2>&1; then
  echo "Refusing: this account has the legacy ChatticusDns stack. Use a dedicated environment account's credentials." >&2
  exit 1
fi

# shellcheck source=budgets-deploy-context.sh
. ./budgets-deploy-context.sh

# shellcheck disable=SC2086
npx cdk deploy "${STACK}" --exclusively --require-approval never -c "chatticusAccountEnvironment=${ENVIRONMENT}" ${BUDGETS_CDK_CONTEXT} ${INTEGRATION_TEST_CDK_CONTEXT}
