#!/bin/bash
# Shared constants for chatticus-3d5357 EFS in-VPC spike.
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="${AWS_REGION}"
export SPIKE_TAG="${SPIKE_TAG:-chatticus-3d5357}"
export AWS_ACCOUNT="${AWS_ACCOUNT:-335163751677}"
export VPC_ID="${VPC_ID:-vpc-0c5a0f0ca21e2afdd}"
export SUBNET_ID="${SUBNET_ID:-subnet-06c4e78bf06400f26}"
export KANBUS_EFS_ID="${KANBUS_EFS_ID:-fs-09fcbd58a2e2d2c98}"
export MOUNT_POINT="${MOUNT_POINT:-/workspace}"
export LOCAL_POINT="${LOCAL_POINT:-/local-workspace}"
export COMPUTERS_STACK="${COMPUTERS_STACK:-ChatticusComputers}"
export SPIKE_STATE_DIR="${SPIKE_STATE_DIR:-/tmp/chatticus-3d5357-efs-invpc/spikes/efs-invpc-3d5357/.spike-state}"
export SPIKE_REPO_URL="${SPIKE_REPO_URL:-https://github.com/AnthusAI/Chatticus.git}"
export SPIKE_BRANCH="${SPIKE_BRANCH:-spike/efs-invpc-3d5357}"
export READONLY_ITERATIONS="${READONLY_ITERATIONS:-20}"
export MUTATING_RUNS="${MUTATING_RUNS:-3}"

mkdir -p "$SPIKE_STATE_DIR"

state_file() {
    echo "${SPIKE_STATE_DIR}/$1"
}

assert_not_kanbus_efs() {
    local fs_id="${1:-}"
    if [ -z "$fs_id" ]; then
        return 0
    fi
    if [ "$fs_id" = "$KANBUS_EFS_ID" ]; then
        echo "REFUSE: target EFS ${fs_id} is Kanbus production filesystem" >&2
        exit 1
    fi
}

verify_computers_desired_count_zero() {
    local cluster service desired
    cluster="$(aws cloudformation describe-stacks \
        --stack-name "$COMPUTERS_STACK" \
        --query 'Stacks[0].Outputs[?OutputKey==`ComputerClusterName`].OutputValue' \
        --output text 2>/dev/null || true)"
    if [ -z "$cluster" ] || [ "$cluster" = "None" ]; then
        echo "WARN: could not resolve ${COMPUTERS_STACK} cluster name for desiredCount check"
        return 0
    fi
    service="$(aws ecs list-services --cluster "$cluster" --query 'serviceArns[0]' --output text 2>/dev/null || true)"
    if [ -z "$service" ] || [ "$service" = "None" ]; then
        echo "WARN: no ECS service in cluster ${cluster}"
        return 0
    fi
    desired="$(aws ecs describe-services --cluster "$cluster" --services "$service" \
        --query 'services[0].desiredCount' --output text)"
    if [ "$desired" != "0" ]; then
        echo "REFUSE: ${COMPUTERS_STACK} desiredCount=${desired}, expected 0" >&2
        exit 1
    fi
    echo "OK: ${COMPUTERS_STACK} desiredCount=0"
}
