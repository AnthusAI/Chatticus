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

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
COMPUTERS_STACK="ChatticusComputers"

read_stack_output() {
  aws cloudformation describe-stacks \
    --stack-name "${COMPUTERS_STACK}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='${1}'].OutputValue" \
    --output text
}

CDK_CONTEXT=""
if CLUSTER="$(read_stack_output ComputerClusterName)" && [ -n "${CLUSTER}" ]; then
  TASK_DEF="$(read_stack_output ComputerTaskDefinitionArn)"
  SERVICE="$(read_stack_output ComputerServiceName)"
  if [ -n "${TASK_DEF}" ] && [ -n "${SERVICE}" ]; then
    NETWORK_JSON="$(
      aws ecs describe-services \
        --cluster "${CLUSTER}" \
        --services "${SERVICE}" \
        --region "${REGION}" \
        --query 'services[0].networkConfiguration.awsvpcConfiguration' \
        --output json
    )"
    SUBNETS="$(
      printf '%s' "${NETWORK_JSON}" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["subnets"]))'
    )"
    SECURITY_GROUPS="$(
      printf '%s' "${NETWORK_JSON}" | python3 -c 'import json,sys; groups=json.load(sys.stdin).get("securityGroups") or []; print(",".join(groups))'
    )"
    ROLES_JSON="$(
      aws ecs describe-task-definition \
        --task-definition "${TASK_DEF}" \
        --region "${REGION}" \
        --query '{executionRoleArn:taskDefinition.executionRoleArn,taskRoleArn:taskDefinition.taskRoleArn}' \
        --output json
    )"
    EXECUTION_ROLE_ARN="$(
      printf '%s' "${ROLES_JSON}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["executionRoleArn"])'
    )"
    TASK_ROLE_ARN="$(
      printf '%s' "${ROLES_JSON}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["taskRoleArn"])'
    )"
    if [ -n "${SUBNETS}" ] && [ -n "${EXECUTION_ROLE_ARN}" ] && [ -n "${TASK_ROLE_ARN}" ]; then
      CDK_CONTEXT="-c computerHostStart=ecs \
-c computerEcsCluster=${CLUSTER} \
-c computerEcsTaskDefinition=${TASK_DEF} \
-c computerEcsSubnets=${SUBNETS} \
-c computerEcsSecurityGroups=${SECURITY_GROUPS} \
-c computerEcsExecutionRoleArn=${EXECUTION_ROLE_ARN} \
-c computerEcsTaskRoleArn=${TASK_ROLE_ARN}"
    fi
  fi
fi

# shellcheck disable=SC2086
npx cdk deploy ChatticusThinTurn --require-approval never ${CDK_CONTEXT}
