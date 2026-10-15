#!/bin/sh
# Move an environment's computer image tag (dev, staging or production) to the image built for one commit.
#
# The build workflows push only the immutable sha-<commit> tag. The owner task definition of the environment runs the
# moving tag, so moving it is the moment a new image reaches every computer start. It moves only when the server side of
# the same content is verified: the newest ControlPlane and ThinTurn deploys of that environment on the commit, or on a
# commit that differs from it only in CHANGELOG.md, package.json and package-lock.json (the release job's commit, which
# is [skip ci] and so is neither deployed nor built), both succeeded. The image used is sha-<commit> when it exists, else
# the image of such an equivalent deployed commit. The previous digest is printed with the command that puts it back.
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
SERVER_SIDE_WORKFLOWS="deploy-controlplane-${ENVIRONMENT}.yml deploy-thinturn-${ENVIRONMENT}.yml"

RELEASE_ONLY_FILES="CHANGELOG.md package.json package-lock.json"

commit_is_equivalent() {
  CANDIDATE="$1"
  if [ "${CANDIDATE}" = "${COMMIT}" ]; then
    return 0
  fi
  if ! COMPARISON="$(gh api "repos/${GH_REPO}/compare/${CANDIDATE}...${COMMIT}" --jq '.status, (.files[].filename)' 2>/dev/null)"; then
    return 1
  fi
  RELATION="$(printf '%s\n' "${COMPARISON}" | sed -n 1p)"
  case "${RELATION}" in
    ahead|behind|identical) ;;
    *) return 1 ;;
  esac
  for CHANGED in $(printf '%s\n' "${COMPARISON}" | sed 1d); do
    case " ${RELEASE_ONLY_FILES} " in
      *" ${CHANGED} "*) ;;
      *) return 1 ;;
    esac
  done
  return 0
}

DEPLOYED_COMMITS=""
for WORKFLOW in ${SERVER_SIDE_WORKFLOWS}; do
  CONCLUSION="none"
  DEPLOYED=""
  RUNS="$(gh run list --workflow "${WORKFLOW}" --limit 50 --json headSha,conclusion --jq '.[] | "\(.headSha) \(.conclusion)"')"
  while read -r RUN_SHA RUN_CONCLUSION; do
    if [ -n "${RUN_SHA}" ] && commit_is_equivalent "${RUN_SHA}"; then
      CONCLUSION="${RUN_CONCLUSION}"
      DEPLOYED="${RUN_SHA}"
      break
    fi
  done <<RUN_LIST_END
${RUNS}
RUN_LIST_END
  if [ "${CONCLUSION}" != "success" ]; then
    echo "Refusing to move the ${TAG} tag: the latest ${WORKFLOW} run for ${COMMIT} (or a commit that differs only in ${RELEASE_ONLY_FILES}) concluded '${CONCLUSION}', not 'success'." >&2
    echo "The image tag flips only after the server side of the same content is deployed and verified." >&2
    exit 1
  fi
  DEPLOYED_COMMITS="${DEPLOYED_COMMITS} ${DEPLOYED}"
done

REPO="$(aws cloudformation describe-stacks \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ComputerRepositoryUri'].OutputValue" \
  --output text)"
REPO_NAME="${REPO#*/}"

NEW_DIGEST=""
for IMAGE_COMMIT in ${COMMIT} ${DEPLOYED_COMMITS}; do
  if NEW_DIGEST="$(aws ecr describe-images --region "${REGION}" \
    --repository-name "${REPO_NAME}" --image-ids "imageTag=sha-${IMAGE_COMMIT}" \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null)"; then
    SHA_TAG="sha-${IMAGE_COMMIT}"
    break
  fi
  NEW_DIGEST=""
done
if [ -z "${NEW_DIGEST}" ]; then
  echo "Refusing to move the ${TAG} tag: ${REPO_NAME} has no image tagged sha-${COMMIT} or for a commit that differs only in ${RELEASE_ONLY_FILES}. Build it first." >&2
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
