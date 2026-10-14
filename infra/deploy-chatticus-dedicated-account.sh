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
if [ "${ENVIRONMENT}" = "production" ] && [ -n "${CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN:-}" ]; then
  echo "CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN must not be set for production; the integration-test principal never exists there." >&2
  exit 1
fi
if { [ "${ENVIRONMENT}" = "development" ] || [ "${ENVIRONMENT}" = "staging" ]; } && [ "${STACK#ChatticusControlPlane}" != "${STACK}" ] && [ -n "${CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN:-}" ]; then
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

# CloudFront carries the invoke key as an origin header resolved by CloudFormation at deploy time. An unchanged
# template is not redeployed, so the web stack is pinned to the secret's current version id: a rotation then changes
# the template and CloudFormation resolves the new value. Only metadata is read, never the key.
INVOKE_KEY_CDK_CONTEXT=""
if [ "$2" = "web" ]; then
  INVOKE_KEY_SECRET_ARN="$(
    aws ssm get-parameter \
      --name "/chatticus/${ENVIRONMENT}/thin-turn/invoke-key-secret-arn" \
      --query 'Parameter.Value' \
      --output text
  )"
  INVOKE_KEY_VERSION_ID="$(
    aws secretsmanager list-secret-version-ids \
      --secret-id "${INVOKE_KEY_SECRET_ARN}" \
      --query "Versions[?contains(VersionStages, 'AWSCURRENT')].VersionId | [0]" \
      --output text
  )"
  if ! printf '%s' "${INVOKE_KEY_VERSION_ID}" | grep -Eq '^[0-9a-fA-F-]{32,64}$'; then
    echo "Could not read the current version id of the ${ENVIRONMENT} invoke key secret; refusing to deploy a stale origin header." >&2
    exit 1
  fi
  INVOKE_KEY_CDK_CONTEXT="-c invokeKeyVersionId=${INVOKE_KEY_VERSION_ID}"
fi

STACK_WAIT_ATTEMPTS=0
while :; do
  STACK_STATUS="$(aws cloudformation describe-stacks --stack-name "${STACK}" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo ABSENT)"
  case "${STACK_STATUS}" in
    *_IN_PROGRESS) ;;
    *) break ;;
  esac
  STACK_WAIT_ATTEMPTS=$((STACK_WAIT_ATTEMPTS + 1))
  if [ "${STACK_WAIT_ATTEMPTS}" -gt 120 ]; then
    echo "${STACK} stayed ${STACK_STATUS} for 30 minutes; refusing to start a competing update." >&2
    exit 1
  fi
  echo "${STACK} is ${STACK_STATUS} (another workflow deploying it); waiting."
  sleep 15
done

# shellcheck source=budgets-deploy-context.sh
. ./budgets-deploy-context.sh

# shellcheck disable=SC2086
npx cdk deploy "${STACK}" --exclusively --require-approval never -c "chatticusAccountEnvironment=${ENVIRONMENT}" ${BUDGETS_CDK_CONTEXT} ${INTEGRATION_TEST_CDK_CONTEXT} ${INVOKE_KEY_CDK_CONTEXT}
