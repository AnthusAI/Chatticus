#!/bin/sh
# Start one Fargate computer via CDK, wait for it to publish a smoke
# snapshot to S3, hydrate that snapshot onto this machine, then scale to 0.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
TENANT="${CHATTICUS_TENANT_ID:-anthus}"
COMPUTER="${CHATTICUS_SMOKE_COMPUTER:-aws-fargate-check}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "Building and pushing the computer image (linux/arm64)..."
docker build -f computer/Dockerfile -t chatticus-computer:dev .
REPO="$(aws cloudformation describe-stacks \
  --stack-name ChatticusComputers \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ComputerRepositoryUri'].OutputValue" \
  --output text)"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${REPO%%/*}"
docker tag chatticus-computer:dev "${REPO}:dev"
docker push "${REPO}:dev"

echo "Deploying one Fargate host (ARM64, smoke publish)..."
cd infra
npx cdk deploy ChatticusComputers \
  --require-approval never \
  -c computerCount=1 \
  -c "smokeComputer=${COMPUTER}"
cd "${ROOT}"

BUCKET="$(aws cloudformation describe-stacks \
  --stack-name ChatticusSnapshots \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='SnapshotBucketName'].OutputValue" \
  --output text)"
CLUSTER="$(aws cloudformation describe-stacks \
  --stack-name ChatticusComputers \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ComputerClusterName'].OutputValue" \
  --output text)"
SERVICE="$(aws cloudformation describe-stacks \
  --stack-name ChatticusComputers \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ComputerServiceName'].OutputValue" \
  --output text)"

echo "Waiting for the Fargate service to stabilize..."
aws ecs wait services-stable --cluster "${CLUSTER}" --services "${SERVICE}" --region "${REGION}"

echo "Waiting for the smoke snapshot in s3://${BUCKET}/..."
export CHATTICUS_SNAPSHOT_BUCKET="${BUCKET}"
i=0
while [ "${i}" -lt 36 ]; do
  if aws s3 ls "s3://${BUCKET}/tenants/${TENANT}/computers/${COMPUTER}/manifest.json" --region "${REGION}" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 5
done
if [ "${i}" -eq 36 ]; then
  echo "FAIL: Fargate did not publish a snapshot" >&2
  aws ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE}" --region "${REGION}" \
    --query 'services[0].{status:status,running:runningCount,events:events[0].message}'
  exit 1
fi

LIVE="$(mktemp -d)"
trap 'rm -rf "${LIVE}"' EXIT
echo "Hydrating the Fargate snapshot onto this machine..."
cd python
# shellcheck disable=SC1091
. .venv/bin/activate
python -m chatticus.snapshot hydrate \
  --live-root "${LIVE}" \
  --store s3 \
  --tenant "${TENANT}" \
  --computer "${COMPUTER}"
GOT="$(cat "${LIVE}/workspace/aws-fargate.md")"
if [ "${GOT}" != "from-aws-fargate" ]; then
  echo "FAIL: hydrated '${GOT}', expected from-aws-fargate" >&2
  exit 1
fi
cd "${ROOT}"

echo "Scaling Fargate back to 0..."
cd infra
npx cdk deploy ChatticusComputers --require-approval never -c computerCount=0
cd "${ROOT}"

echo "OK: Fargate computer published; this machine hydrated it; service is at 0"
