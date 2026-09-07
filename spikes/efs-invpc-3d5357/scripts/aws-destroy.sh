#!/bin/bash
# Tear down spike-only resources. Safe to run multiple times.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/aws-env.sh
source "${ROOT}/scripts/aws-env.sh"

destroy_spike_resources() {
    local fs_id instance_id ec2_sg efs_sg mt_id role_name profile_name

    fs_id="$(cat "$(state_file efs-id)" 2>/dev/null || true)"
    instance_id="$(cat "$(state_file instance-id)" 2>/dev/null || true)"
    ec2_sg="$(cat "$(state_file ec2-sg)" 2>/dev/null || true)"
    efs_sg="$(cat "$(state_file efs-sg)" 2>/dev/null || true)"
    role_name="$(cat "$(state_file role-name)" 2>/dev/null || true)"
    profile_name="$(cat "$(state_file profile-name)" 2>/dev/null || true)"

    assert_not_kanbus_efs "$fs_id"

    if [ -n "$instance_id" ] && [ "$instance_id" != "None" ]; then
        echo "Terminating EC2 ${instance_id}..."
        aws ec2 terminate-instances --instance-ids "$instance_id" >/dev/null || true
        aws ec2 wait instance-terminated --instance-ids "$instance_id" 2>/dev/null || true
        rm -f "$(state_file instance-id)"
    fi

    if [ -n "$fs_id" ] && [ "$fs_id" != "None" ]; then
        mt_id="$(aws efs describe-mount-targets --file-system-id "$fs_id" \
            --query 'MountTargets[0].MountTargetId' --output text 2>/dev/null || true)"
        if [ -n "$mt_id" ] && [ "$mt_id" != "None" ]; then
            echo "Deleting mount target ${mt_id}..."
            aws efs delete-mount-target --mount-target-id "$mt_id" || true
            aws efs wait mount-target-deleted --mount-target-id "$mt_id" 2>/dev/null || true
        fi
        echo "Deleting EFS ${fs_id}..."
        aws efs delete-file-system --file-system-id "$fs_id" || true
        aws efs wait file-system-deleted --file-system-id "$fs_id" 2>/dev/null || true
        rm -f "$(state_file efs-id)"
    fi

    if [ -n "$efs_sg" ] && [ "$efs_sg" != "None" ]; then
        aws ec2 delete-security-group --group-id "$efs_sg" 2>/dev/null || true
        rm -f "$(state_file efs-sg)"
    fi
    if [ -n "$ec2_sg" ] && [ "$ec2_sg" != "None" ]; then
        aws ec2 delete-security-group --group-id "$ec2_sg" 2>/dev/null || true
        rm -f "$(state_file ec2-sg)"
    fi

    if [ -n "$profile_name" ] && [ "$profile_name" != "None" ]; then
        aws iam remove-role-from-instance-profile \
            --instance-profile-name "$profile_name" \
            --role-name "${role_name:-${SPIKE_TAG}-ssm-role}" 2>/dev/null || true
        aws iam delete-instance-profile --instance-profile-name "$profile_name" 2>/dev/null || true
        rm -f "$(state_file profile-name)"
    fi
    if [ -n "$role_name" ] && [ "$role_name" != "None" ]; then
        aws iam detach-role-policy \
            --role-name "$role_name" \
            --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null || true
        aws iam delete-role --role-name "$role_name" 2>/dev/null || true
        rm -f "$(state_file role-name)"
    fi

    verify_computers_desired_count_zero || true
    echo "Destroy complete for tag ${SPIKE_TAG}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    destroy_spike_resources
fi
