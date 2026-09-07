#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/aws-env.sh
source "${ROOT}/scripts/aws-env.sh"

verify_computers_desired_count_zero

AMI_ID="$(aws ssm get-parameters \
    --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
    --query 'Parameters[0].Value' --output text)"

ROLE_NAME="${SPIKE_TAG}-ssm-role"
PROFILE_NAME="${SPIKE_TAG}-ssm-profile"
TRUST_DOC='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST_DOC" \
        --tags Key=chatticus-spike,Value="${SPIKE_TAG}" >/dev/null
fi
aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null 2>&1 || true

if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
    aws iam create-instance-profile \
        --instance-profile-name "$PROFILE_NAME" \
        --tags Key=chatticus-spike,Value="${SPIKE_TAG}" >/dev/null
fi
aws iam add-role-to-instance-profile \
    --instance-profile-name "$PROFILE_NAME" \
    --role-name "$ROLE_NAME" >/dev/null 2>&1 || true
sleep 15

echo "$ROLE_NAME" >"$(state_file role-name)"
echo "$PROFILE_NAME" >"$(state_file profile-name)"

EC2_SG="$(aws ec2 create-security-group \
    --group-name "${SPIKE_TAG}-ec2-$$" \
    --description "EFS spike EC2 egress only (${SPIKE_TAG})" \
    --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=chatticus-spike,Value=${SPIKE_TAG}},{Key=Name,Value=${SPIKE_TAG}-ec2}]" \
    --query GroupId --output text)"
echo "$EC2_SG" >"$(state_file ec2-sg)"

EFS_SG="$(aws ec2 create-security-group \
    --group-name "${SPIKE_TAG}-efs-$$" \
    --description "EFS spike NFS from spike EC2 (${SPIKE_TAG})" \
    --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=chatticus-spike,Value=${SPIKE_TAG}},{Key=Name,Value=${SPIKE_TAG}-efs}]" \
    --query GroupId --output text)"
echo "$EFS_SG" >"$(state_file efs-sg)"

aws ec2 authorize-security-group-ingress \
    --group-id "$EFS_SG" --protocol tcp --port 2049 --source-group "$EC2_SG" >/dev/null

EFS_ID="$(aws efs create-file-system \
    --performance-mode generalPurpose \
    --encrypted \
    --tags Key=chatticus-spike,Value="${SPIKE_TAG}" Key=Name,Value="${SPIKE_TAG}" \
    --query FileSystemId --output text)"
assert_not_kanbus_efs "$EFS_ID"
echo "$EFS_ID" >"$(state_file efs-id)"

wait_efs_available "$EFS_ID"

aws efs create-mount-target \
    --file-system-id "$EFS_ID" \
    --subnet-id "$SUBNET_ID" \
    --security-groups "$EFS_SG" >/dev/null

MT_ID="$(aws efs describe-mount-targets --file-system-id "$EFS_ID" \
    --query 'MountTargets[0].MountTargetId' --output text)"
wait_mount_target_available "$MT_ID"

USERDATA="${ROOT}/scripts/ec2-userdata.sh"
INSTANCE_ID="$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type t3.medium \
    --subnet-id "$SUBNET_ID" \
    --security-group-ids "$EC2_SG" \
    --iam-instance-profile Name="$PROFILE_NAME" \
    --associate-public-ip-address \
    --tag-specifications "ResourceType=instance,Tags=[{Key=chatticus-spike,Value=${SPIKE_TAG}},{Key=Name,Value=${SPIKE_TAG}-bench}]" \
    --user-data "file://${USERDATA}" \
    --metadata-options HttpTokens=required \
    --query 'Instances[0].InstanceId' --output text)"
echo "$INSTANCE_ID" >"$(state_file instance-id)"

aws ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"

echo "Waiting for SSM agent on ${INSTANCE_ID}..."
for _ in $(seq 1 60); do
    ping="$(aws ssm describe-instance-information \
        --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
        --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
    if [ "$ping" = "Online" ]; then
        break
    fi
    sleep 10
done

MT_IP="$(aws efs describe-mount-targets --file-system-id "$EFS_ID" \
    --query 'MountTargets[0].IpAddress' --output text)"

cat >"${ROOT}/results/lab-info-partial.json" <<EOF
{
  "spike_tag": "${SPIKE_TAG}",
  "vpc_id": "${VPC_ID}",
  "subnet_id": "${SUBNET_ID}",
  "availability_zone": "us-east-1a",
  "instance_id": "${INSTANCE_ID}",
  "instance_type": "t3.medium",
  "efs_id": "${EFS_ID}",
  "kanbus_efs_guard": "${KANBUS_EFS_ID}",
  "efs_mount_target_ip": "${MT_IP}",
  "nfs_version": "4.1",
  "efs_mount_tls": true,
  "in_vpc": true,
  "access": "ssm_only"
}
EOF

echo "Created instance=${INSTANCE_ID} efs=${EFS_ID} mt_ip=${MT_IP}"
