#!/bin/sh
# Build the computer image and push :dev to the ChatticusComputers ECR
# repository. Does not deploy ChatticusComputers and does not change
# desiredCount.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

unset AWS_PROFILE || true
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before pushing the computer image." >&2
  exit 1
fi

echo "Building linux/arm64 computer image..."
docker build --platform linux/arm64 -f computer/Dockerfile -t chatticus-computer:dev .
REPO="$(aws cloudformation describe-stacks \
  --stack-name ChatticusComputers \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ComputerRepositoryUri'].OutputValue" \
  --output text)"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${REPO%%/*}"
docker tag chatticus-computer:dev "${REPO}:dev"
docker push "${REPO}:dev"
echo "OK: pushed ${REPO}:dev"
