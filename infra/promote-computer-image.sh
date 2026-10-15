#!/bin/sh
# Move an environment's computer image tag (dev, staging or production) to the image built for one commit.
#
# The build workflows push only the immutable sha-<commit> tag. The owner task definition of the environment runs the
# moving tag, so moving it is the moment a new image reaches every computer start. It moves only when the server side of
# the same commit is verified: the latest ControlPlane and ThinTurn deploys of that environment for that commit both
# succeeded (the staging and production deploys are manual dispatches, so the rule is "a dispatch of each ran on this
# commit and succeeded"). The previous digest is printed with the command that puts it back.
#
# usage: sh promote-computer-image.sh <development|staging|production> <full 40 character commit sha>
# needs: gh (GH_TOKEN, GH_REPO), aws (that environment's session or its OIDC deploy role)
set -eu

ENVIRONMENT="${1:-}"
COMMIT="${2:-}"
case "${ENVIRONMENT}" in
  development) TAG="dev"; STACK="ChatticusComputers" ;;
  staging) TAG="staging"; STACK="ChatticusComputersStaging" ;;
  production) TAG="production"; STACK="ChatticusComputers" ;;
  *)
    echo "usage: sh promote-computer-image.sh <development|staging|production> <full 40 character commit sha>" >&2
    exit 2
    ;;
esac
if ! printf '%s' "${COMMIT}" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "usage: sh promote-computer-image.sh <development|staging|production> <full 40 character commit sha>" >&2
  exit 2
fi

REGION="${AWS_REGION:-us-east-1}"
SHA_TAG="sha-${COMMIT}"
SERVER_SIDE_WORKFLOWS="deploy-controlplane-${ENVIRONMENT}.yml deploy-thinturn-${ENVIRONMENT}.yml"

for WORKFLOW in ${SERVER_SIDE_WORKFLOWS}; do
  CONCLUSION="$(gh run list --workflow "${WORKFLOW}" --commit "${COMMIT}" --limit 1 --json conclusion --jq '.[0].conclusion // "none"')"
  if [ "${CONCLUSION}" != "success" ]; then
    echo "Refusing to move the ${TAG} tag: the latest ${WORKFLOW} run for ${COMMIT} concluded '${CONCLUSION}', not 'success'." >&2
    echo "The image tag flips only after the server side of the same commit is deployed and verified." >&2
    exit 1
  fi
done

REPO="$(aws cloudformation describe-stacks \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ComputerRepositoryUri'].OutputValue" \
  --output text)"
REPO_NAME="${REPO#*/}"

if ! NEW_DIGEST="$(aws ecr describe-images --region "${REGION}" \
  --repository-name "${REPO_NAME}" --image-ids "imageTag=${SHA_TAG}" \
  --query 'imageDetails[0].imageDigest' --output text)"; then
  echo "Refusing to move the ${TAG} tag: ${REPO_NAME} has no image tagged ${SHA_TAG}. Build it first." >&2
  exit 1
fi

PREVIOUS_DIGEST="$(aws ecr describe-images --region "${REGION}" \
  --repository-name "${REPO_NAME}" --image-ids imageTag=${TAG} \
  --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || echo none)"

if [ "${PREVIOUS_DIGEST}" = "${NEW_DIGEST}" ]; then
  echo "OK: ${TAG} already points at ${SHA_TAG} (${NEW_DIGEST}); nothing to move."
  exit 0
fi

MANIFEST="$(aws ecr batch-get-image --region "${REGION}" \
  --repository-name "${REPO_NAME}" --image-ids "imageTag=${SHA_TAG}" \
  --query 'images[0].imageManifest' --output text)"
MANIFEST_MEDIA_TYPE="$(aws ecr batch-get-image --region "${REGION}" \
  --repository-name "${REPO_NAME}" --image-ids "imageTag=${SHA_TAG}" \
  --query 'images[0].imageManifestMediaType' --output text)"

aws ecr put-image --region "${REGION}" \
  --repository-name "${REPO_NAME}" --image-tag ${TAG} \
  --image-manifest "${MANIFEST}" --image-manifest-media-type "${MANIFEST_MEDIA_TYPE}" >/dev/null

MOVED_DIGEST="$(aws ecr describe-images --region "${REGION}" \
  --repository-name "${REPO_NAME}" --image-ids imageTag=${TAG} \
  --query 'imageDetails[0].imageDigest' --output text)"
if [ "${MOVED_DIGEST}" != "${NEW_DIGEST}" ]; then
  echo "${TAG} points at ${MOVED_DIGEST} after the move, not ${NEW_DIGEST}." >&2
  exit 1
fi

if [ "${PREVIOUS_DIGEST}" = "none" ]; then
  ROLLBACK="(${TAG} had no previous image; there is nothing to roll back to)"
else
  ROLLBACK="aws ecr put-image --region ${REGION} --repository-name ${REPO_NAME} --image-tag ${TAG} --image-manifest \"\$(aws ecr batch-get-image --region ${REGION} --repository-name ${REPO_NAME} --image-ids imageDigest=${PREVIOUS_DIGEST} --query 'images[0].imageManifest' --output text)\""
fi

echo "OK: moved ${TAG} to ${SHA_TAG} (${NEW_DIGEST}); previous ${TAG} digest ${PREVIOUS_DIGEST}"
echo "Roll back with: ${ROLLBACK}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Computer image promoted to ${ENVIRONMENT} (${TAG})"
    echo ""
    echo "- repository: \`${REPO_NAME}\`"
    echo "- environment: \`${ENVIRONMENT}\`"
    echo "- commit: \`${COMMIT}\`"
    echo "- new digest: \`${NEW_DIGEST}\`"
    echo "- previous digest: \`${PREVIOUS_DIGEST}\`"
    echo "- roll back: \`${ROLLBACK}\`"
  } >> "${GITHUB_STEP_SUMMARY}"
fi
