#!/bin/sh
# BREAK-GLASS ONLY. CI builds, checks and pushes the computer image on every
# change to develop (.github/workflows/build-computer-image-development.yml).
# Use this script by hand only when CI cannot run.
# Build the computer image and push it to the development ECR repository (ChatticusComputersDevelopment)
# under an immutable manual-<utc time> tag. It never moves :dev: the dev tag moves
# only after the server side of the same commit is deployed and verified, through
# .github/workflows/promote-computer-image-development.yml or the documented
# promotion command (docs/COMPUTER_IMAGE_PROMOTION.md). Does not deploy
# ChatticusComputersDevelopment and does not change desiredCount.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

unset AWS_PROFILE || true
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
MANUAL_TAG="manual-$(date -u +%Y%m%dT%H%M%SZ)"

if ! aws sts get-caller-identity >/dev/null; then
  echo "aws login required before pushing the computer image." >&2
  exit 1
fi

echo "Building linux/arm64 computer image..."
docker build --platform linux/arm64 -f computer/Dockerfile -t chatticus-computer:manual .
REPO="$(aws cloudformation describe-stacks \
  --stack-name ChatticusComputersDevelopment \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ComputerRepositoryUri'].OutputValue" \
  --output text)"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${REPO%%/*}"
docker tag chatticus-computer:manual "${REPO}:${MANUAL_TAG}"
docker push "${REPO}:${MANUAL_TAG}"
echo "OK: pushed ${REPO}:${MANUAL_TAG}; dev is unchanged."
echo "Move dev to it only after the server side is verified: see docs/COMPUTER_IMAGE_PROMOTION.md."
