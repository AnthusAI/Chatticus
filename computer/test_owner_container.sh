#!/bin/sh
# Builds the slim computer image and proves, inside the real container, that the
# owner supervisor starts (settings, runtime directory, liveness file, watchdog,
# SIGTERM), that the per-turn owner program refuses to run without its settings,
# that it runs a local command through the shell launcher, and that the command's
# user cannot reach the credentials the supervisor and the owner process hold.
# Needs Docker and no AWS. Run from anywhere:
#   sh computer/test_owner_container.sh
# CI builds the image once and passes it in: set CHATTICUS_OWNER_TEST_IMAGE and
# CHATTICUS_OWNER_TEST_SKIP_BUILD=1 to test that image without rebuilding.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

IMAGE="${CHATTICUS_OWNER_TEST_IMAGE:-chatticus-computer:owner-test}"
OWNER=/opt/chatticus/host/owner.mjs
SUPERVISOR=/opt/chatticus/host/supervisor.mjs
SECRET_KEY="owner-test-model-key-5f1c"
SECRET_AWS="owner-test-aws-secret-8d2e"
SECRET_TOKEN="owner-test-gateway-token-3b7a"
SECRET_INVOKE="owner-test-bootstrap-token-9c4d"

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
    -e CHATTICUS_OWNER_BOOTSTRAP_TOKEN="${SECRET_INVOKE}" \
    "${IMAGE}" node "${OWNER}" "$@"
}

probe() {
  owner shell-probe "$1" 2>&1 || true
}

started="$(date +%s)"
owner_exit=0
owner >/dev/null 2>&1 || owner_exit=$?
if [ "${owner_exit}" = "2" ]; then pass "the owner program started without a subcommand exits 2 and runs no turn"; else fail "the owner program without a subcommand exited ${owner_exit}, expected 2"; fi

owner_exit=0
out="$(owner turn 2>&1)" || owner_exit=$?
if [ "${owner_exit}" = "2" ] && ! echo "${out}" | grep -q "${SECRET_TOKEN}"; then pass "the owner turn subcommand without its settings exits 2 and names no secret"; else fail "the owner turn subcommand without settings: exit ${owner_exit}: ${out}"; fi

supervisor_exit=0
out="$(docker run --rm -e CHATTICUS_OWNER_BOOTSTRAP_TOKEN="${SECRET_INVOKE}" "${IMAGE}" node "${SUPERVISOR}" 2>&1)" || supervisor_exit=$?
if [ "${supervisor_exit}" = "7" ] && echo "${out}" | grep -q '^owner_configuration_invalid' && ! echo "${out}" | grep -q "${SECRET_INVOKE}"; then pass "the supervisor without its settings exits 7 and never prints the bootstrap token"; else fail "the supervisor without settings: exit ${supervisor_exit}: ${out}"; fi

watchdog_exit=0
docker run --rm "${IMAGE}" chatticus-watchdog 99999999 >/dev/null 2>&1 || watchdog_exit=$?
if [ "${watchdog_exit}" = "0" ]; then pass "the watchdog of a supervisor that is gone exits 0"; else fail "the watchdog of a gone supervisor exited ${watchdog_exit}"; fi

SUPERVISOR_CONTAINER="chatticus-supervisor-test-$$"
trap 'docker rm -f "${SUPERVISOR_CONTAINER}" >/dev/null 2>&1 || true' EXIT
docker run -d --name "${SUPERVISOR_CONTAINER}" \
  -e CHATTICUS_TENANT_ID=anthus \
  -e CHATTICUS_USER_ID=ryan \
  -e CHATTICUS_OWNER_ID=owner-container-test \
  -e CHATTICUS_OWNER_START_GENERATION=1 \
  -e CHATTICUS_OWNER_BOOTSTRAP_TOKEN="${SECRET_INVOKE}" \
  -e CHATTICUS_FRONT_DOOR_URL=http://127.0.0.1:9 \
  -e CHATTICUS_MODEL_GATEWAY_URL=http://127.0.0.1:9/v1 \
  -e CHATTICUS_MESSAGING_TABLE=messaging \
  -e CHATTICUS_CONVERSATIONS_TABLE=conversations \
  -e CHATTICUS_PI_SESSIONS_BUCKET=pi-sessions \
  -e CHATTICUS_SNAPSHOT_BUCKET=snapshots \
  -e CHATTICUS_ENVIRONMENT=development \
  -e AWS_REGION=us-east-1 \
  "${IMAGE}" node "${SUPERVISOR}" >/dev/null
sleep 3

logs="$(docker logs "${SUPERVISOR_CONTAINER}" 2>&1)"
if echo "${logs}" | grep -q '^owner_started ' && ! echo "${logs}" | grep -q "${SECRET_INVOKE}"; then pass "the supervisor starts, logs owner_started and never logs the bootstrap token"; else fail "the supervisor log: ${logs}"; fi

if docker exec "${SUPERVISOR_CONTAINER}" test -f /run/chatticus/supervisor.alive; then pass "the supervisor keeps its liveness file"; else fail "the supervisor has no liveness file"; fi

mode="$(docker exec "${SUPERVISOR_CONTAINER}" stat -c %a /run/chatticus)"
if [ "${mode}" = "700" ]; then pass "the runtime directory of the supervisor and the watchdog is mode 700"; else fail "the runtime directory is mode ${mode}"; fi

if docker exec "${SUPERVISOR_CONTAINER}" sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\000" " "' | grep -q 'chatticus-watchdog'; then pass "the watchdog runs as its own process beside the supervisor"; else fail "no watchdog process runs in the supervisor container"; fi

out="$(docker exec --user 2000 "${SUPERVISOR_CONTAINER}" sh -c 'cat /proc/1/environ 2>&1; cat /run/chatticus/supervisor.alive 2>&1' || true)"
if echo "${out}" | grep -qi 'permission denied' && ! echo "${out}" | grep -q "${SECRET_INVOKE}"; then pass "the unprivileged shell user cannot read the supervisor's environment or its runtime directory"; else fail "the unprivileged user reached the supervisor: ${out}"; fi

out="$(docker exec "${SUPERVISOR_CONTAINER}" sh -c 'env | grep -c "^AWS_ACCESS_KEY_ID=\|^AWS_SECRET_ACCESS_KEY=\|^AWS_SESSION_TOKEN=" || true')"
if [ "${out}" = "0" ]; then pass "the supervisor's task environment holds no AWS access key, secret key or session token"; else fail "the task environment holds ${out} AWS credential variable(s)"; fi

docker stop -t 10 "${SUPERVISOR_CONTAINER}" >/dev/null
stopped_code="$(docker inspect --format '{{.State.ExitCode}}' "${SUPERVISOR_CONTAINER}")"
if [ "${stopped_code}" = "143" ]; then pass "SIGTERM stops the supervisor with exit code 143"; else fail "the supervisor stopped with exit code ${stopped_code}, expected 143"; fi

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

# The live file operations the supervisor runs for a member go through the same helper as the shell user. live-file-probe maps
# a request exactly as the supervisor does and prints the outcome the supervisor would post.
live_tool() {
  docker run --rm -i -e OWNER="${OWNER}" "${IMAGE}" sh -s -- "$@" 2>&1 <<'CONTAINER_SCRIPT' || true
chatticus-shell -c 'mkdir -p /workspace/dir /workspace/.git
echo listed > /workspace/dir/a.txt
printf "edit-me" > /workspace/edit.txt
echo "[core]" > /workspace/.git/config
ln -s .git/config /workspace/sneaky
mkfifo /workspace/fifo'
hash="$(printf "edit-me" | sha256sum | cut -d" " -f1)"
case "$1" in
  write-if-match) node "${OWNER}" live-file-probe write /workspace/edit.txt edited "${hash}" ;;
  *) node "${OWNER}" live-file-probe "$@" ;;
esac
echo "edit-after=$(cat /workspace/edit.txt)"
echo "git-config-after=$(cat /workspace/.git/config)"
echo "edit-owner=$(stat -c %u /workspace/edit.txt)"
echo "temporaries=$(ls -A /workspace | grep -c 'chatticus-.*tmp' || true)"
CONTAINER_SCRIPT
}

out="$(live_tool list /workspace/dir)"
if echo "${out}" | grep -q '^live_file_probe_ok' && echo "${out}" | grep -q '"name":"a.txt"'; then pass "the live listing runs as the shell user and lists a directory"; else fail "the live listing: ${out}"; fi

out="$(live_tool read /workspace/edit.txt)"
if echo "${out}" | grep -q '^live_file_probe_ok' && echo "${out}" | grep -q '"content":"edit-me"'; then pass "the live read returns the file's text and its hash"; else fail "the live read: ${out}"; fi

out="$(live_tool write-if-match)"
if echo "${out}" | grep -q '^live_file_probe_ok' && echo "${out}" | grep -q '^edit-after=edited$' && echo "${out}" | grep -q '^edit-owner=2000$' && echo "${out}" | grep -q '^temporaries=0$'; then pass "the live write replaces the file atomically as the shell user and leaves no temporary file"; else fail "the live write: ${out}"; fi

out="$(live_tool write /workspace/edit.txt edited 0000000000000000000000000000000000000000000000000000000000000000)"
if echo "${out}" | grep -q '^live_file_probe_error precondition_failed' && echo "${out}" | grep -q '^edit-after=edit-me$'; then pass "the live write with a stale hash is refused and changes nothing"; else fail "the stale live write: ${out}"; fi

out="$(live_tool write /workspace/sneaky planted)"
if echo "${out}" | grep -q '^live_file_probe_error path_refused' && echo "${out}" | grep -q '^git-config-after=\[core\]$'; then pass "the live write through a link to a .git file is refused"; else fail "the live write into .git: ${out}"; fi

out="$(live_tool read /workspace/fifo)"
if echo "${out}" | grep -q '^live_file_probe_error not_a_file'; then pass "the live read of a pipe is refused and does not hang"; else fail "the live read of a pipe: ${out}"; fi

# The overlay entries the supervisor applies after a hydrate go through the same helper, as the shell user. overlay-probe seals
# nothing and reads no bucket: it applies a file of entries and a directory of blobs with the supervisor's applier and prints what
# it applied and what it reported as conflicts. The edit, the delete and the new folder must land as uid 2000, and a link to a
# root-only file must become a conflict that leaves the file unchanged.
overlay_tool() {
  docker run --rm -i -e OWNER="${OWNER}" "${IMAGE}" sh -s 2>&1 <<'CONTAINER_SCRIPT' || true
echo "root-only" > /root/secret
chmod 600 /root/secret
chatticus-shell -c 'printf "edit-me" > /workspace/edit.txt
printf "gone" > /workspace/gone.txt
ln -s /root/secret /workspace/leak'
hash_of() { printf "%s" "$1" | sha256sum | cut -d" " -f1; }
secret_hash="$(sha256sum /root/secret | cut -d" " -f1)"
edit_base="$(hash_of edit-me)"
edit_new="$(hash_of edited-by-mia)"
gone_base="$(hash_of gone)"
plant="$(hash_of planted)"
mkdir /tmp/blobs
printf "edited-by-mia" > "/tmp/blobs/${edit_new}"
printf "planted" > "/tmp/blobs/${plant}"
stamp='"edited_by":"mia","edited_at":"2026-10-12T08:00:00.000Z","revision":1,"conflict":null'
cat > /tmp/entries.json <<JSON
[
{"path":"/workspace/edit.txt",${stamp},"op":"put","sha256":"${edit_new}","size":13,"mode":"664","base_sha256":"${edit_base}","from":null,"from_sha256":null},
{"path":"/workspace/leak",${stamp},"op":"put","sha256":"${plant}","size":7,"mode":"664","base_sha256":"${secret_hash}","from":null,"from_sha256":null},
{"path":"/workspace/gone.txt",${stamp},"op":"delete","directory":false,"recursive":false,"base_sha256":"${gone_base}","tree_sha256":null},
{"path":"/workspace/docs",${stamp},"op":"mkdir","mode":"775"}
]
JSON
node "${OWNER}" overlay-probe /tmp/entries.json /tmp/blobs
echo "edit-after=$(cat /workspace/edit.txt)"
echo "edit-owner=$(stat -c %u /workspace/edit.txt)"
echo "gone-exists=$(test -e /workspace/gone.txt && echo yes || echo no)"
echo "docs-owner=$(stat -c %u /workspace/docs 2>/dev/null || echo none)"
echo "secret-after=$(cat /root/secret)"
CONTAINER_SCRIPT
}

out="$(overlay_tool)"
if echo "${out}" | grep -q '^overlay_probe_ok' && echo "${out}" | grep -q '^edit-after=edited-by-mia$' && echo "${out}" | grep -q '^edit-owner=2000$' && echo "${out}" | grep -q '^gone-exists=no$' && echo "${out}" | grep -q '^docs-owner=2000$'; then pass "an overlay edit, delete and new folder are applied by the helper as the unprivileged user"; else fail "the overlay entries: ${out}"; fi
if echo "${out}" | grep -q '"conflicts":\[{"path":"/workspace/leak"' && echo "${out}" | grep -q '^secret-after=root-only$'; then pass "an overlay edit of a link to a root-only file is a conflict and the file is unchanged"; else fail "the overlay entry for a link: ${out}"; fi

if [ "${failures}" -ne 0 ]; then
  echo "${failures} check(s) failed"
  exit 1
fi
echo "all checks passed"
