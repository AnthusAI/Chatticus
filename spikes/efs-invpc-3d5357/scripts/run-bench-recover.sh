#!/bin/bash
# Run benchmark + fetch + destroy on existing spike resources (state files populated).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/aws-env.sh
source "${ROOT}/scripts/aws-env.sh"
# shellcheck source=scripts/aws-destroy.sh
source "${ROOT}/scripts/aws-destroy.sh"

DESTROY_DONE=0
trap 'if [ "$DESTROY_DONE" -eq 0 ]; then destroy_spike_resources || true; fi' EXIT

INSTANCE_ID="$(cat "$(state_file instance-id)")"
EFS_ID="$(cat "$(state_file efs-id)")"
assert_not_kanbus_efs "$EFS_ID"

WORKTREE_ROOT="$(cd "${ROOT}/../.." && pwd)"
git -C "$WORKTREE_ROOT" push origin "${SPIKE_BRANCH}" 2>/dev/null || true

PARTIAL_B64="$(python3 -c "import base64; print(base64.b64encode(open('${ROOT}/results/lab-info-partial.json','rb').read()).decode())")"

REMOTE_SETUP=$(cat <<'EOS'
set -euo pipefail
export EFS_ID='__EFS_ID__'
export SPIKE_BRANCH='__SPIKE_BRANCH__'
export SPIKE_REPO_URL='__SPIKE_REPO_URL__'
export SPIKE_REMOTE='/opt/chatticus-repo/spikes/efs-invpc-3d5357'
rm -rf /opt/chatticus-repo
git clone --branch "${SPIKE_BRANCH}" --depth 1 "${SPIKE_REPO_URL}" /opt/chatticus-repo
mkdir -p "${SPIKE_REMOTE}/results/raw"
echo '__PARTIAL_B64__' | base64 -d > "${SPIKE_REMOTE}/results/lab-info-partial.json"
chmod +x "${SPIKE_REMOTE}/scripts/"*.sh
export SPIKE_ROOT="${SPIKE_REMOTE}"
bash "${SPIKE_REMOTE}/scripts/run-all-on-ec2.sh"
EOS
)
REMOTE_SETUP="${REMOTE_SETUP//__EFS_ID__/$EFS_ID}"
REMOTE_SETUP="${REMOTE_SETUP//__SPIKE_BRANCH__/$SPIKE_BRANCH}"
REMOTE_SETUP="${REMOTE_SETUP//__SPIKE_REPO_URL__/$SPIKE_REPO_URL}"
REMOTE_SETUP="${REMOTE_SETUP//__PARTIAL_B64__/$PARTIAL_B64}"

python3 - "$INSTANCE_ID" "$REMOTE_SETUP" <<'PY'
import base64
import json
import subprocess
import sys
import time

instance_id = sys.argv[1]
script = sys.argv[2]
b64 = base64.b64encode(script.encode()).decode()
remote = f"echo {b64} | base64 -d > /tmp/spike-bench.sh && chmod +x /tmp/spike-bench.sh && bash /tmp/spike-bench.sh"
proc = subprocess.run(
    [
        "aws", "ssm", "send-command",
        "--instance-ids", instance_id,
        "--document-name", "AWS-RunShellScript",
        "--timeout-seconds", "7200",
        "--parameters", json.dumps({"commands": [remote]}),
        "--query", "Command.CommandId",
        "--output", "text",
    ],
    check=True, capture_output=True, text=True,
)
cmd_id = proc.stdout.strip()
print(f"SSM command {cmd_id} started")
for _ in range(240):
    inv = subprocess.run(
        ["aws", "ssm", "get-command-invocation", "--command-id", cmd_id,
         "--instance-id", instance_id, "--output", "json"],
        capture_output=True, text=True,
    )
    if inv.returncode != 0:
        time.sleep(15)
        continue
    data = json.loads(inv.stdout)
    status = data.get("Status")
    if status in {"Success", "Cancelled", "TimedOut", "Failed"}:
        print(data.get("StandardOutputContent", "")[-6000:])
        if data.get("StandardErrorContent"):
            print("STDERR:", data["StandardErrorContent"][-2000:], file=sys.stderr)
        if status != "Success":
            raise SystemExit(f"SSM command failed: {status}")
        break
    time.sleep(15)
else:
    raise SystemExit("SSM command timed out waiting")
PY

bash "${ROOT}/scripts/fetch-results.sh" "$INSTANCE_ID"
DESTROY_DONE=1
destroy_spike_resources
echo "Recover bench complete."
