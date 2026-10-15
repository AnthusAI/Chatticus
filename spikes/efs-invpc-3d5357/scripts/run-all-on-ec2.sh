#!/bin/bash
set -euo pipefail

SPIKE_ROOT="${SPIKE_ROOT:-/opt/chatticus-spike}"
EFS_ID="${EFS_ID:?EFS_ID required}"
export SPIKE_ROOT EFS_ID LOCAL_POINT MOUNT_POINT

set -x
bash "${SPIKE_ROOT}/scripts/seed-workspace.sh"
bash "${SPIKE_ROOT}/scripts/run-ebs-control.sh"
bash "${SPIKE_ROOT}/scripts/run-readonly-sweep.sh"
bash "${SPIKE_ROOT}/scripts/run-mutating-sweep.sh"
bash "${SPIKE_ROOT}/scripts/summarize.sh"
echo "Bench complete on $(hostname)"
