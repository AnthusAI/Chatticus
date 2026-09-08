#!/bin/sh
# Mirror Anthus :dev into a customer-account ChatticusComputers ECR repository.
# Uses the organization cross-account role. ComputerWorker never publishes.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

unset AWS_PROFILE || true
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before publishing the customer computer image." >&2
  exit 1
fi

ROLE_ARN="${CHATTICUS_CUSTOMER_ROLE_ARN:-}"
EXTERNAL_ID="${CHATTICUS_ORGANIZATION_ID:-}"
if [ -z "${ROLE_ARN}" ] || [ -z "${EXTERNAL_ID}" ]; then
  echo "Set CHATTICUS_CUSTOMER_ROLE_ARN and CHATTICUS_ORGANIZATION_ID." >&2
  exit 1
fi

echo "Assuming customer cross-account role..."
CREDS="$(aws sts assume-role \
  --role-arn "${ROLE_ARN}" \
  --role-session-name chatticus-push-customer-computer-image \
  --external-id "${EXTERNAL_ID}" \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
  --output text)"
read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<EOF
${CREDS}
EOF
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

CUSTOMER_REPO="$(aws cloudformation describe-stacks \
  --stack-name ChatticusComputers \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ComputerRepositoryUri'].OutputValue" \
  --output text)"
if [ -z "${CUSTOMER_REPO}" ] || [ "${CUSTOMER_REPO}" = "None" ]; then
  echo "Customer ChatticusComputers stack is missing ComputerRepositoryUri." >&2
  exit 1
fi

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
ANTHUS_REPO="$(aws cloudformation describe-stacks \
  --stack-name ChatticusComputers \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ComputerRepositoryUri'].OutputValue" \
  --output text)"

echo "Building linux/arm64 computer image..."
docker build --platform linux/arm64 -f computer/Dockerfile -t chatticus-computer:dev .

aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ANTHUS_REPO%%/*}"
docker tag chatticus-computer:dev "${ANTHUS_REPO}:dev"
docker push "${ANTHUS_REPO}:dev"

read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<EOF
${CREDS}
EOF
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${CUSTOMER_REPO%%/*}"
docker tag chatticus-computer:dev "${CUSTOMER_REPO}:dev"
docker push "${CUSTOMER_REPO}:dev"

echo "OK: published ${CUSTOMER_REPO}:dev from Anthus ${ANTHUS_REPO}:dev"
