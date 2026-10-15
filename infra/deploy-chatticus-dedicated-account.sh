#!/bin/sh
# Deploy ONE stack of ONE environment into the account that holds it. Never --all.
# Run with that account's credentials, never the legacy account's. Staging and
# production share one account. Production's stacks keep the unsuffixed ids they
# were deployed under (ChatticusSnapshots, ChatticusComputers, and so on); staging's
# carry a Staging suffix, so the two never collide. ChatticusBudgets is
# account-level and belongs to production: only development and production deploy
# it, staging reads its alerts topic from the production copy.
#
# Development fault switch of the owner credential broker
# (docs/OWNER_CREDENTIAL_RENEWAL.md, R22). It exists for the development
# control-plane only; this script refuses it for any other environment and CDK
# synthesis fails for staging and production when the context is set. To prove
# renewal failure live, deploy the development ControlPlane with one or both of
#   OWNER_BROKER_FAULT=deny_supervisor_renewal   (none, deny_supervisor_renewal, deny_turn_renewal)
#   OWNER_BROKER_CREDENTIAL_SECONDS=900          (900 to 3600)
# for example:
#   OWNER_BROKER_FAULT=deny_supervisor_renewal OWNER_BROKER_CREDENTIAL_SECONDS=900 \
#     sh deploy-chatticus-dedicated-account.sh development control-plane
# They become the CDK context ownerBrokerFault and ownerBrokerCredentialSeconds.
# To restore, run the same deploy again with neither variable set: the broker's
# two variables are then removed from the function.
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
  development:budgets | production:budgets) STACK="ChatticusBudgets" ;;
  development:snapshots) STACK="ChatticusSnapshots" ;;
  development:computers) STACK="ChatticusComputers" ;;
  development:zones) STACK="ChatticusEnvironmentZones" ;;
  development:certificates) STACK="ChatticusEnvironmentCertificates" ;;
  development:thin-turn) STACK="ChatticusThinTurn" ;;
  development:control-plane) STACK="ChatticusControlPlane" ;;
  development:web) STACK="ChatticusWeb" ;;
  development:auth) STACK="ChatticusAuth" ;;
  staging:snapshots) STACK="ChatticusSnapshotsStaging" ;;
  staging:computers) STACK="ChatticusComputersStaging" ;;
  staging:zones) STACK="ChatticusEnvironmentZonesStaging" ;;
  staging:certificates) STACK="ChatticusEnvironmentCertificatesStaging" ;;
  staging:thin-turn) STACK="ChatticusThinTurnStaging" ;;
  staging:control-plane) STACK="ChatticusControlPlaneStaging" ;;
  staging:web) STACK="ChatticusWebStaging" ;;
  staging:auth) STACK="ChatticusAuthStaging" ;;
  production:snapshots) STACK="ChatticusSnapshots" ;;
  production:computers) STACK="ChatticusComputers" ;;
  production:zones) STACK="ChatticusEnvironmentZones" ;;
  production:certificates) STACK="ChatticusEnvironmentCertificates" ;;
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

BROKER_FAULT_CDK_CONTEXT=""
if [ "${OWNER_BROKER_FAULT:-}" != "" ] || [ "${OWNER_BROKER_CREDENTIAL_SECONDS:-}" != "" ]; then
  if [ "${ENVIRONMENT}" != "development" ] || [ "$2" != "control-plane" ]; then
    echo "The broker fault switch exists for the development control-plane only." >&2
    exit 1
  fi
  if [ "${OWNER_BROKER_FAULT:-}" != "" ]; then
    BROKER_FAULT_CDK_CONTEXT="${BROKER_FAULT_CDK_CONTEXT} -c ownerBrokerFault=${OWNER_BROKER_FAULT}"
  fi
  if [ "${OWNER_BROKER_CREDENTIAL_SECONDS:-}" != "" ]; then
    BROKER_FAULT_CDK_CONTEXT="${BROKER_FAULT_CDK_CONTEXT} -c ownerBrokerCredentialSeconds=${OWNER_BROKER_CREDENTIAL_SECONDS}"
  fi
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

STACK_POLL_SECONDS="${CHATTICUS_STACK_POLL_SECONDS:-15}"
STACK_WAIT_MAXIMUM_POLLS=120
DEPLOY_MAXIMUM_ATTEMPTS=5
OVERLAPPING_DEPLOY_MESSAGE_PATTERNS="is in [A-Z_]*IN_PROGRESS state and can not be updated
Cannot delete ChangeSet in status CREATE_IN_PROGRESS
ChangeSet .* already exists
ConcurrentModificationException
concurrent update"

wait_for_stack_to_settle() {
  STACK_WAIT_ATTEMPTS=0
  while :; do
    STACK_STATUS="$(aws cloudformation describe-stacks --stack-name "${STACK}" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo ABSENT)"
    case "${STACK_STATUS}" in
      *_IN_PROGRESS) ;;
      *) return 0 ;;
    esac
    STACK_WAIT_ATTEMPTS=$((STACK_WAIT_ATTEMPTS + 1))
    if [ "${STACK_WAIT_ATTEMPTS}" -gt "${STACK_WAIT_MAXIMUM_POLLS}" ]; then
      echo "${STACK} stayed ${STACK_STATUS} for 30 minutes; refusing to start a competing update." >&2
      exit 1
    fi
    echo "${STACK} is ${STACK_STATUS} (another workflow deploying it); waiting."
    sleep "${STACK_POLL_SECONDS}"
  done
}

wait_for_stack_to_settle

# shellcheck source=budgets-deploy-context.sh
. ./budgets-deploy-context.sh

DEPLOY_WORK_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "${DEPLOY_WORK_DIRECTORY}"' EXIT
CLOUD_ASSEMBLY_DIRECTORY="${DEPLOY_WORK_DIRECTORY}/cdk.out"
DEPLOY_OUTPUT_FILE="${DEPLOY_WORK_DIRECTORY}/deploy-output.txt"
DEPLOY_STATUS_FILE="${DEPLOY_WORK_DIRECTORY}/deploy-status.txt"

# shellcheck disable=SC2086
npx cdk synth "${STACK}" --exclusively --quiet --output "${CLOUD_ASSEMBLY_DIRECTORY}" -c "chatticusAccountEnvironment=${ENVIRONMENT}" ${BUDGETS_CDK_CONTEXT} ${INTEGRATION_TEST_CDK_CONTEXT} ${INVOKE_KEY_CDK_CONTEXT} ${BROKER_FAULT_CDK_CONTEXT}

DEPLOY_ATTEMPT=0
while :; do
  DEPLOY_ATTEMPT=$((DEPLOY_ATTEMPT + 1))
  {
    npx cdk deploy "${STACK}" --exclusively --require-approval never --app "${CLOUD_ASSEMBLY_DIRECTORY}" && echo 0 >"${DEPLOY_STATUS_FILE}" || echo "$?" >"${DEPLOY_STATUS_FILE}"
  } 2>&1 | tee "${DEPLOY_OUTPUT_FILE}"
  DEPLOY_EXIT_CODE="$(cat "${DEPLOY_STATUS_FILE}")"
  if [ "${DEPLOY_EXIT_CODE}" -eq 0 ]; then
    exit 0
  fi
  if ! printf '%s\n' "${OVERLAPPING_DEPLOY_MESSAGE_PATTERNS}" | grep -Eif - "${DEPLOY_OUTPUT_FILE}" >/dev/null; then
    exit "${DEPLOY_EXIT_CODE}"
  fi
  if [ "${DEPLOY_ATTEMPT}" -ge "${DEPLOY_MAXIMUM_ATTEMPTS}" ]; then
    echo "${STACK} deploy lost the race to another workflow ${DEPLOY_ATTEMPT} times; giving up." >&2
    exit "${DEPLOY_EXIT_CODE}"
  fi
  echo "${STACK} deploy attempt ${DEPLOY_ATTEMPT} hit an in-progress update from another workflow; waiting for it to settle, then retrying."
  wait_for_stack_to_settle
done
