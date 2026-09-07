#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/aws-env.sh
source "${ROOT}/scripts/aws-env.sh"

INSTANCE_ID="${1:?usage: fetch-results.sh <instance-id>}"
SPIKE_REMOTE="${SPIKE_REMOTE:-/opt/chatticus-repo/spikes/efs-invpc-3d5357}"
LOCAL_RESULTS="${ROOT}/results"

mkdir -p "${LOCAL_RESULTS}/raw"

ssm_cat() {
    local remote_path="$1"
    local local_path="$2"
    local cmd_id output

    cmd_id="$(aws ssm send-command \
        --instance-ids "$INSTANCE_ID" \
        --document-name AWS-RunShellScript \
        --parameters "commands=[\"cat '${remote_path}'\"]" \
        --query 'Command.CommandId' --output text)"

    for _ in $(seq 1 120); do
        status="$(aws ssm get-command-invocation \
            --command-id "$cmd_id" \
            --instance-id "$INSTANCE_ID" \
            --query 'Status' --output text 2>/dev/null || true)"
        if [ "$status" = "Success" ] || [ "$status" = "Failed" ]; then
            break
        fi
        sleep 5
    done

    output="$(aws ssm get-command-invocation \
        --command-id "$cmd_id" \
        --instance-id "$INSTANCE_ID" \
        --query 'StandardOutputContent' --output text 2>/dev/null || true)"
    if [ -z "$output" ] || [ "$output" = "None" ]; then
        echo "WARN: empty fetch for ${remote_path}" >&2
        return 1
    fi
    printf '%s' "$output" >"$local_path"
}

list_cmd_id="$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --parameters "commands=[\"find '${SPIKE_REMOTE}/results' -type f \\( -name '*.md' -o -name 'lab-info.json' -o -name 'ebs-control.json' -o -name 'efs-readonly-actimeo-*.json' -o -name 'efs-mutating-actimeo-*.json' \\) ! -name '*-iter*' ! -name '*-run*' ! -name '*.rpc.json' | sort\"]" \
    --query 'Command.CommandId' --output text)"

for _ in $(seq 1 60); do
    status="$(aws ssm get-command-invocation --command-id "$list_cmd_id" --instance-id "$INSTANCE_ID" \
        --query 'Status' --output text 2>/dev/null || true)"
    [ "$status" = "Success" ] && break
    sleep 3
done

file_list="$(aws ssm get-command-invocation --command-id "$list_cmd_id" --instance-id "$INSTANCE_ID" \
    --query 'StandardOutputContent' --output text)"

if [ -z "$file_list" ] || [ "$file_list" = "None" ]; then
    echo "ERROR: no result files found on instance" >&2
    exit 1
fi

while IFS= read -r remote; do
    [ -z "$remote" ] && continue
    rel="${remote#${SPIKE_REMOTE}/results/}"
    local_path="${LOCAL_RESULTS}/${rel}"
    mkdir -p "$(dirname "$local_path")"
    echo "Fetching ${rel}..."
    ssm_cat "$remote" "$local_path" || true
done <<<"$file_list"

if [ -f "${ROOT}/results/lab-info-partial.json" ] && [ -f "${LOCAL_RESULTS}/lab-info.json" ]; then
    python3 - "${ROOT}/results/lab-info-partial.json" "${LOCAL_RESULTS}/lab-info.json" <<'PY'
import json, sys
from pathlib import Path
partial = json.loads(Path(sys.argv[1]).read_text())
lab = json.loads(Path(sys.argv[2]).read_text())
partial.update(lab)
Path(sys.argv[2]).write_text(json.dumps(partial, indent=2) + "\n")
PY
fi

echo "Fetched results into ${LOCAL_RESULTS}"
