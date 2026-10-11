#!/bin/sh
# Builds the slim computer image and proves, inside the real container, that the
# owner program starts, runs a local command through the shell launcher, and that
# the command's user cannot reach the credentials the owner process holds.
# Needs Docker and no AWS. Run from anywhere:
#   sh computer/test_owner_container.sh
# CI builds the image once and passes it in: set CHATTICUS_OWNER_TEST_IMAGE and
# CHATTICUS_OWNER_TEST_SKIP_BUILD=1 to test that image without rebuilding.
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

if [ "${CHATTICUS_OWNER_TEST_SKIP_BUILD:-}" = "1" ]; then
  echo "Using the already built ${IMAGE}"
else
  echo "Building ${IMAGE}"
  docker build -q -f computer/Dockerfile -t "${IMAGE}" .
fi

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

# The file tools run in the owner process, which is root. A symbolic link the unprivileged shell plants in the
# workspace must not let them read or overwrite what only root can reach. Each check runs in one container: as root it
# plants a root-only secret, then as the shell user it plants links, then the owner's own file tool runs on a link.
FILE_SECRET="owner-test-root-only-secret-6a1f"
file_tool() {
  docker run --rm -i -e FILE_SECRET="${FILE_SECRET}" -e OWNER="${OWNER}" "${IMAGE}" sh -s -- "$@" 2>&1 <<'CONTAINER_SCRIPT' || true
echo "${FILE_SECRET}" > /root/secret
chmod 600 /root/secret
cp /usr/local/bin/chatticus-shell /tmp/launcher.before
chatticus-shell -c 'ln -s /root/secret /workspace/link-secret
ln -s /proc/1/environ /workspace/link-environ
ln -s /usr/local/bin/chatticus-shell /workspace/link-launcher
ln -s /root /workspace/link-root
ln -s /root/not-yet /workspace/link-dangling
echo plain-content > /workspace/plain.txt
echo alpha-beta > /workspace/edit.txt'
node "${OWNER}" file-probe "$@"
echo "secret-after=$(cat /root/secret)"
echo "launcher-same=$(cmp -s /tmp/launcher.before /usr/local/bin/chatticus-shell && echo yes || echo no)"
echo "dangling-created=$(test -e /root/not-yet && echo yes || echo no)"
echo "root-entries=$(ls /root | tr '\n' ' ')"
echo "owner-of-new=$(stat -c %u /workspace/new/dir/file.txt 2>/dev/null || echo none)"
CONTAINER_SCRIPT
}

out="$(file_tool read_workspace /workspace/link-secret)"
if echo "${out}" | grep -q '^file_probe_error' && ! echo "${out}" | grep -q "^file_probe_ok"; then pass "read_workspace through a link to a root-only file is refused"; else fail "read_workspace through a link to a root-only file: ${out}"; fi
echo "INFO  $(echo "${out}" | grep '^file_probe_')"

out="$(file_tool read_workspace /workspace/link-environ)"
if echo "${out}" | grep -q '^file_probe_error'; then pass "read_workspace through a link to /proc/1/environ is refused"; else fail "read_workspace through a link to /proc/1/environ: ${out}"; fi
echo "INFO  $(echo "${out}" | grep '^file_probe_')"

out="$(file_tool write_workspace /workspace/link-secret overwritten)"
if echo "${out}" | grep -q '^file_probe_error' && echo "${out}" | grep -q "^secret-after=${FILE_SECRET}"; then pass "write_workspace through a link to a root-only file is refused and the file is unchanged"; else fail "write_workspace through a link to a root-only file: ${out}"; fi

out="$(file_tool write_workspace /workspace/link-launcher '#!/bin/sh')"
if echo "${out}" | grep -q '^file_probe_error' && echo "${out}" | grep -q '^launcher-same=yes'; then pass "write_workspace through a link to the shell launcher is refused and the launcher is unchanged"; else fail "write_workspace through a link to the shell launcher: ${out}"; fi

out="$(file_tool edit_workspace /workspace/link-secret "${FILE_SECRET}" changed)"
if echo "${out}" | grep -q '^file_probe_error' && echo "${out}" | grep -q "^secret-after=${FILE_SECRET}"; then pass "edit_workspace through a link to a root-only file is refused and the file is unchanged"; else fail "edit_workspace through a link to a root-only file: ${out}"; fi

out="$(file_tool write_workspace /workspace/link-root/planted.txt planted)"
if echo "${out}" | grep -q '^file_probe_error' && echo "${out}" | grep -q '^root-entries=secret $'; then pass "write_workspace under a link to /root is refused and plants nothing there"; else fail "write_workspace under a link to /root: ${out}"; fi

out="$(file_tool write_workspace /workspace/link-dangling planted)"
if echo "${out}" | grep -q '^file_probe_error' && echo "${out}" | grep -q '^dangling-created=no'; then pass "write_workspace through a dangling link into /root creates nothing there"; else fail "write_workspace through a dangling link: ${out}"; fi

out="$(file_tool read_workspace /workspace/plain.txt)"
if echo "${out}" | grep -q '^file_probe_ok: plain-content'; then pass "read_workspace still reads a normal workspace file"; else fail "read_workspace of a normal file: ${out}"; fi

out="$(file_tool write_workspace /workspace/new/dir/file.txt fresh)"
if echo "${out}" | grep -q '^file_probe_ok' && echo "${out}" | grep -q '^owner-of-new=2000$'; then pass "write_workspace still writes a normal file, creating directories, and the file belongs to the unprivileged user"; else fail "write_workspace of a normal file: ${out}"; fi

out="$(file_tool edit_workspace /workspace/edit.txt beta gamma)"
if echo "${out}" | grep -q '^file_probe_ok'; then pass "edit_workspace still edits a normal workspace file"; else fail "edit_workspace of a normal file: ${out}"; fi

out="$(file_tool edit_workspace /workspace/edit.txt omega gamma)"
if echo "${out}" | grep -q '^file_probe_error: Could not find the exact text'; then pass "edit_workspace keeps its exact-match refusal"; else fail "edit_workspace exact-match refusal: ${out}"; fi

if [ "${failures}" -ne 0 ]; then
  echo "${failures} check(s) failed"
  exit 1
fi
echo "all checks passed"
