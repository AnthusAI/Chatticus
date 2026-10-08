#!/bin/sh
# Builds the slim computer image and proves, inside the real container, that the
# owner program starts, runs a local command through the shell launcher, and that
# the command's user cannot reach the credentials the owner process holds.
# Needs Docker and no AWS. Run from anywhere:
#   sh computer/test_owner_container.sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

IMAGE="${CHATTICUS_OWNER_TEST_IMAGE:-chatticus-computer:owner-test}"
OWNER=/opt/chatticus/host/owner.mjs
SECRET_KEY="owner-test-model-key-5f1c"
SECRET_AWS="owner-test-aws-secret-8d2e"
SECRET_TOKEN="owner-test-gateway-token-3b7a"
SECRET_INVOKE="owner-test-host-token-9c4d"

failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures + 1)); }

echo "Building ${IMAGE}"
docker build -q -f computer/Dockerfile -t "${IMAGE}" .

owner() {
  docker run --rm \
    -e OPENAI_API_KEY="${SECRET_KEY}" \
    -e AWS_SECRET_ACCESS_KEY="${SECRET_AWS}" \
    -e AWS_SESSION_TOKEN="${SECRET_AWS}" \
    -e CHATTICUS_MODEL_GATEWAY_TOKEN="${SECRET_TOKEN}" \
    -e CHATTICUS_INVOKE_KEY="${SECRET_INVOKE}" \
    "${IMAGE}" node "${OWNER}" "$@"
}

probe() {
  owner shell-probe "$1" 2>&1 || true
}

started="$(date +%s)"
if owner 2>&1 | grep -q '^owner_no_job$'; then pass "the owner program starts and finds no takeover job"; else fail "the owner program did not start cleanly"; fi

first_tool_started="$(date +%s)"
uid="$(probe 'id -u')"
shell_uid="$(docker run --rm "${IMAGE}" id -u chatticus-shell)"
first_tool_ended="$(date +%s)"
if [ "${uid}" = "${shell_uid}" ] && [ "${uid}" != "0" ]; then pass "a local command runs as the unprivileged uid ${uid}"; else fail "the local command ran as uid '${uid}', expected ${shell_uid}"; fi
echo "INFO  start to first local tool result: $((first_tool_ended - started)) s (tool call itself about $((first_tool_ended - first_tool_started)) s with the image start of the id lookup)"

out="$(probe 'cat /proc/{owner_pid}/environ')"
if echo "${out}" | grep -qi 'permission denied'; then pass "the shell cannot read the owner's /proc environment"; else fail "the shell could read the owner's /proc environment: ${out}"; fi

out="$(probe 'cat /proc/{owner_pid}/cmdline /proc/{owner_pid}/maps >/dev/null; echo done')"
if echo "${out}" | grep -q 'done' && ! echo "${out}" | grep -qi 'permission denied'; then
  echo "INFO  cmdline and maps of the owner were readable; they hold no credentials"
fi

out="$(probe 'env')"
leaked=0
for secret in "${SECRET_KEY}" "${SECRET_AWS}" "${SECRET_TOKEN}" "${SECRET_INVOKE}"; do
  if echo "${out}" | grep -q "${secret}"; then leaked=1; fi
done
if [ "${leaked}" = "0" ] && echo "${out}" | grep -q '^HOME='; then pass "the shell environment holds none of the owner's secrets"; else fail "the shell environment leaked or is empty: ${out}"; fi

out="$(probe 'cat /proc/1/environ')"
if echo "${out}" | grep -qi 'permission denied'; then pass "the shell cannot read the init process environment"; else fail "the shell could read /proc/1/environ"; fi

out="$(probe 'id -u; cat /var/lib/chatticus/store/x 2>&1; ls /var/lib/chatticus/store 2>&1')"
if echo "${out}" | grep -qi 'permission denied'; then pass "the shell cannot read the local snapshot store"; else fail "the shell could read the snapshot store: ${out}"; fi

out="$(probe 'echo from-shell > /workspace/from-shell.txt && cat /workspace/from-shell.txt')"
if [ "${out}" = "from-shell" ]; then pass "the shell can write the workspace"; else fail "the shell could not write the workspace: ${out}"; fi

out="$(probe 'sudo -n true 2>&1; su -c true 2>&1; setpriv --reuid=0 true 2>&1; echo escalation-end')"
if ! echo "${out}" | grep -q 'escalation-end' || echo "${out}" | grep -qi 'not permitted\|not found\|denied\|must be run\|Authentication'; then pass "the shell cannot become root"; else fail "the shell may have become root: ${out}"; fi

if [ "${failures}" -ne 0 ]; then
  echo "${failures} check(s) failed"
  exit 1
fi
echo "all checks passed"
