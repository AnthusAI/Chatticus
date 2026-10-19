#!/bin/sh
# Rotate the shared invoke key of ONE environment: put a new secret value, redeploy the web stack so CloudFront
# carries it, verify, then retire the previous value. The key is never printed, logged or put on a command line.
# See docs/AWS_AUTH.md "Rotating the invoke key" for the order, the cache window and what breaks (customer host workers).
set -eu

cd "$(dirname "$0")"

usage() {
  echo "usage: sh rotate-invoke-key.sh development|staging|production --yes [--dry-run] [--resume]" >&2
  echo "  --yes      required to write anything" >&2
  echo "  --dry-run  read-only: print the steps and run the read-only checks" >&2
  echo "  --resume   finish a rotation that stopped after the new value was put (no new value is generated)" >&2
  echo "Credentials: profile chatticus-production (all three environments share that account), or CHATTICUS_AWS_PROFILE; region us-east-1." >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
case "$1" in
  development | staging | production) ENVIRONMENT="$1" ;;
  *) usage ;;
esac
shift

CONFIRMED=0
DRY_RUN=0
RESUME=0
for ARGUMENT in "$@"; do
  case "${ARGUMENT}" in
    --yes) CONFIRMED=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --resume) RESUME=1 ;;
    *) usage ;;
  esac
done
if [ "${CONFIRMED}" -ne 1 ] && [ "${DRY_RUN}" -ne 1 ]; then
  echo "Refusing to rotate without --yes (or use --dry-run)." >&2
  exit 2
fi

AWS_PROFILE="${CHATTICUS_AWS_PROFILE:-chatticus-production}"
AWS_REGION="us-east-1"
AWS_DEFAULT_REGION="us-east-1"
export AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION

CACHE_WAIT_SECONDS="${CHATTICUS_ROTATE_CACHE_WAIT_SECONDS:-65}"
INVOKE_HEADER="X-Chatticus-Invoke-Key"
REFUSAL_TEXT="invoke key required"
PREFIX="/chatticus/${ENVIRONMENT}"

step() {
  echo "==> $*"
}

fail() {
  echo "FAILED: $*" >&2
  exit 1
}

write_step() {
  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "    (dry run) would: $*"
    return 1
  fi
  return 0
}

ssm_value() {
  aws ssm get-parameter --name "$1" --query 'Parameter.Value' --output text
}

step "Checking the AWS session for ${ENVIRONMENT} (profile ${AWS_PROFILE})"
CALLER_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || fail "aws credentials for profile ${AWS_PROFILE} are not usable; run aws login / aws sso login first"

SECRET_ARN="$(ssm_value "${PREFIX}/thin-turn/invoke-key-secret-arn")"
DISTRIBUTION_ID="$(ssm_value "${PREFIX}/web/cloudfront-distribution-id")"
SITE_API_URL="$(ssm_value "${PREFIX}/thin-turn/cloudfront-url")"
[ -n "${SECRET_ARN}" ] && [ -n "${DISTRIBUTION_ID}" ] && [ -n "${SITE_API_URL}" ] || fail "the ThinTurn or Web SSM parameters under ${PREFIX} are missing"
SITE_API_URL="${SITE_API_URL%/}"

case "${SECRET_ARN}" in
  "arn:aws:secretsmanager:${AWS_REGION}:${CALLER_ACCOUNT}:secret:"*) ;;
  *) fail "the invoke key secret is not in the account of profile ${AWS_PROFILE}; refusing to touch another account" ;;
esac

FUNCTION_URL_HOST="$(
  aws cloudfront get-distribution-config --id "${DISTRIBUTION_ID}" \
    --query "DistributionConfig.Origins.Items[?contains(DomainName, 'lambda-url')].DomainName | [0]" \
    --output text
)"
[ -n "${FUNCTION_URL_HOST}" ] && [ "${FUNCTION_URL_HOST}" != "None" ] || fail "could not find the Front Door Function URL origin in distribution ${DISTRIBUTION_ID}"
FUNCTION_URL="https://${FUNCTION_URL_HOST}"

stage_version() {
  aws secretsmanager list-secret-version-ids --secret-id "${SECRET_ARN}" \
    --query "Versions[?contains(VersionStages, '$1')].VersionId | [0]" --output text
}

CURRENT_VERSION="$(stage_version AWSCURRENT)"
PREVIOUS_VERSION="$(stage_version AWSPREVIOUS)"
[ -n "${CURRENT_VERSION}" ] && [ "${CURRENT_VERSION}" != "None" ] || fail "the invoke key secret has no current version"
HAS_PREVIOUS=1
if [ -z "${PREVIOUS_VERSION}" ] || [ "${PREVIOUS_VERSION}" = "None" ]; then
  HAS_PREVIOUS=0
fi

echo "    secret:        ${SECRET_ARN}"
echo "    current:       ${CURRENT_VERSION}"
echo "    previous:      $([ "${HAS_PREVIOUS}" -eq 1 ] && echo "${PREVIOUS_VERSION}" || echo none)"
echo "    distribution:  ${DISTRIBUTION_ID}"
echo "    cloudfront:    ${SITE_API_URL}"
echo "    function url:  ${FUNCTION_URL}"

if [ "${RESUME}" -eq 0 ] && [ "${HAS_PREVIOUS}" -eq 1 ]; then
  fail "the secret still stages a previous value, so an earlier rotation did not finish. Run again with --resume to redeploy, verify and retire it. Rotating now could leave CloudFront carrying a key the Front Door no longer accepts."
fi
if [ "${RESUME}" -eq 1 ] && [ "${HAS_PREVIOUS}" -eq 0 ]; then
  fail "--resume was given but there is no previous value to retire; nothing to resume"
fi

body_of() {
  curl -sS --max-time 20 -o "$1" -w '%{http_code}' "$2"
}

WORK_FILE="$(mktemp)"
trap 'rm -f "${WORK_FILE}"' EXIT INT TERM

verify_open_routes() {
  STATUS="$(body_of "${WORK_FILE}" "${SITE_API_URL}/health")" || fail "CloudFront health route unreachable at ${SITE_API_URL}/health"
  [ "${STATUS}" = "200" ] || fail "CloudFront ${SITE_API_URL}/health answered ${STATUS}, expected 200"
  echo "    ok: CloudFront health route answers 200 without a key"
  STATUS="$(body_of "${WORK_FILE}" "${FUNCTION_URL}/health")" || fail "Function URL health route unreachable"
  [ "${STATUS}" = "200" ] || fail "Function URL /health answered ${STATUS}, expected 200"
  echo "    ok: Function URL health route answers 200 without a key"
}

verify_direct_refuses_no_key() {
  STATUS="$(body_of "${WORK_FILE}" "${FUNCTION_URL}/me")" || fail "Function URL unreachable"
  if [ "${STATUS}" != "403" ] && [ "${STATUS}" != "401" ]; then
    fail "Function URL /me with no key answered ${STATUS}, expected 401 or 403"
  fi
  grep -q "${REFUSAL_TEXT}" "${WORK_FILE}" || fail "Function URL /me with no key was refused, but not by the invoke key gate"
  echo "    ok: the Function URL refuses a request with no invoke key (${STATUS})"
}

verify_cloudfront_carries_accepted_key() {
  STATUS="$(body_of "${WORK_FILE}" "${SITE_API_URL}/me")" || fail "CloudFront unreachable at ${SITE_API_URL}/me"
  if grep -q "${REFUSAL_TEXT}" "${WORK_FILE}"; then
    fail "CloudFront ${SITE_API_URL}/me was refused by the invoke key gate (${STATUS}): the key CloudFront carries is not accepted"
  fi
  echo "    ok: CloudFront passes the invoke key gate on a protected route (${STATUS}, refused further in only by the missing user credential)"
}

HEADER_QUERY="DistributionConfig.Origins.Items[].CustomHeaders.Items[?HeaderName=='${INVOKE_HEADER}'].HeaderValue[] | [0]"

step "Read-only checks before any change"
verify_open_routes
verify_direct_refuses_no_key
verify_cloudfront_carries_accepted_key
HEADER_COUNT="$(
  aws cloudfront get-distribution-config --id "${DISTRIBUTION_ID}" \
    --query "length(DistributionConfig.Origins.Items[].CustomHeaders.Items[?HeaderName=='${INVOKE_HEADER}'].HeaderValue[])" \
    --output text
)"
[ "${HEADER_COUNT}" = "1" ] || fail "expected exactly one ${INVOKE_HEADER} origin header in distribution ${DISTRIBUTION_ID}, found ${HEADER_COUNT}"
echo "    ok: the distribution has exactly one ${INVOKE_HEADER} origin header"

if [ "${RESUME}" -eq 0 ]; then
  step "Put a new random value in the secret (the previous value stays staged as AWSPREVIOUS)"
  if write_step "aws secretsmanager get-random-password --password-length 40 --exclude-punctuation, then put-secret-value into ${SECRET_ARN} through stdin (the value is never printed)"; then
    NEW_VALUE="$(aws secretsmanager get-random-password --password-length 40 --exclude-punctuation --query RandomPassword --output text)"
    [ "${#NEW_VALUE}" -ge 32 ] || fail "the generated value is too short"
    printf '%s' "${NEW_VALUE}" | aws secretsmanager put-secret-value --secret-id "${SECRET_ARN}" --secret-string file:///dev/stdin --query VersionId --output text >/dev/null || fail "put-secret-value failed; nothing changed"
    NEW_VALUE=""
    echo "    ok: new value stored"
  fi
  PREVIOUS_TO_RETIRE="${CURRENT_VERSION}"
else
  PREVIOUS_TO_RETIRE="${PREVIOUS_VERSION}"
fi

step "Wait ${CACHE_WAIT_SECONDS}s so every warm Front Door has read the new value (it accepts the new and the previous value from then on)"
if write_step "sleep ${CACHE_WAIT_SECONDS}"; then
  sleep "${CACHE_WAIT_SECONDS}"
fi

step "Redeploy the web stack so CloudFront carries the new value"
case "${ENVIRONMENT}" in
  development)
    WORKFLOW="Deploy Web (development)"
    if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
      echo "    gh is not available or not logged in. Run this yourself, wait for it to finish, then re-run this script with --resume --yes:" >&2
      echo "    gh workflow run '${WORKFLOW}' --ref develop" >&2
      [ "${DRY_RUN}" -eq 1 ] || exit 3
    fi
    if write_step "gh workflow run '${WORKFLOW}' --ref develop, then gh run watch --exit-status"; then
      gh workflow run "${WORKFLOW}" --ref develop || fail "could not dispatch ${WORKFLOW}"
      sleep 10
      RUN_ID="$(gh run list --workflow "${WORKFLOW}" --branch develop --limit 1 --json databaseId --jq '.[0].databaseId')"
      [ -n "${RUN_ID}" ] || fail "could not find the dispatched run of ${WORKFLOW}"
      gh run watch "${RUN_ID}" --exit-status || fail "${WORKFLOW} run ${RUN_ID} failed. The Front Door still accepts both values, so nothing is down; fix the deploy and re-run with --resume --yes."
    fi
    ;;
  staging | production)
    if write_step "sh deploy-chatticus-dedicated-account.sh ${ENVIRONMENT} web (pins the new secret version id)"; then
      sh deploy-chatticus-dedicated-account.sh "${ENVIRONMENT}" web || fail "the ${ENVIRONMENT} web deploy failed. The Front Door still accepts both values; fix it and re-run with --resume --yes."
    fi
    ;;
esac

step "Wait for the CloudFront distribution to finish deploying"
if write_step "aws cloudfront wait distribution-deployed --id ${DISTRIBUTION_ID}"; then
  aws cloudfront wait distribution-deployed --id "${DISTRIBUTION_ID}" || fail "the distribution did not reach Deployed"
fi

step "Verify that CloudFront now carries exactly the current value (compared in memory, never printed)"
if write_step "compare the ${INVOKE_HEADER} origin header with the AWSCURRENT secret value"; then
  HEADER_VALUE="$(aws cloudfront get-distribution-config --id "${DISTRIBUTION_ID}" --query "${HEADER_QUERY}" --output text)"
  CURRENT_VALUE="$(aws secretsmanager get-secret-value --secret-id "${SECRET_ARN}" --version-stage AWSCURRENT --query SecretString --output text)"
  if [ -z "${HEADER_VALUE}" ] || [ "${HEADER_VALUE}" != "${CURRENT_VALUE}" ]; then
    HEADER_VALUE=""
    CURRENT_VALUE=""
    fail "CloudFront does not carry the current invoke key yet. The Front Door still accepts both values, so nothing is down. Check the web deploy, then re-run with --resume --yes. The previous value was NOT retired."
  fi
  HEADER_VALUE=""
  CURRENT_VALUE=""
  echo "    ok: the CloudFront origin header equals the current secret value"
fi

step "Retire the previous value (the old key stops working for everyone, including customer host workers that still hold it)"
if write_step "aws secretsmanager update-secret-version-stage --version-stage AWSPREVIOUS --remove-from-version-id ${PREVIOUS_TO_RETIRE}"; then
  aws secretsmanager update-secret-version-stage --secret-id "${SECRET_ARN}" --version-stage AWSPREVIOUS --remove-from-version-id "${PREVIOUS_TO_RETIRE}" >/dev/null || fail "could not retire the previous value; the old key is still accepted. Re-run with --resume --yes"
  echo "    ok: previous value retired"
fi

step "Wait ${CACHE_WAIT_SECONDS}s for every Front Door to drop the previous value, then verify"
if write_step "sleep ${CACHE_WAIT_SECONDS}"; then
  sleep "${CACHE_WAIT_SECONDS}"
fi
if [ "${DRY_RUN}" -eq 1 ]; then
  echo "    (dry run) would re-run the checks below after the wait"
fi
verify_open_routes
verify_direct_refuses_no_key
verify_cloudfront_carries_accepted_key

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "Dry run finished. Nothing was written."
else
  echo "Rotation of the ${ENVIRONMENT} invoke key finished. Now run the acceptance runner: cd conversation && npx tsx bin/acceptance.ts --environment ${ENVIRONMENT}"
fi
