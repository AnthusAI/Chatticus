#!/bin/bash
set -euo pipefail

SPIKE_ROOT="${SPIKE_ROOT:-/opt/chatticus-spike}"
LOCAL_POINT="${LOCAL_POINT:-/local-workspace}"
MOUNT_POINT="${MOUNT_POINT:-/workspace}"
EFS_ID="${EFS_ID:?EFS_ID required}"
ITERATIONS="${READONLY_ITERATIONS:-20}"

# shellcheck source=scripts/lib-bench.sh
source "${SPIKE_ROOT}/scripts/lib-bench.sh"

RESULTS_DIR="${SPIKE_ROOT}/results"
mkdir -p "${RESULTS_DIR}/raw"

copy_repo_to_efs() {
    mkdir -p "$MOUNT_POINT"
    rm -rf "${MOUNT_POINT}/chatticus" "${MOUNT_POINT}/.pip-scratch" "${MOUNT_POINT}/small-pip"
    cp -a "${LOCAL_POINT}/chatticus" "${MOUNT_POINT}/chatticus"
    mkdir -p "${MOUNT_POINT}/.pip-scratch"
    cp -a "${LOCAL_POINT}/small-pip" "${MOUNT_POINT}/small-pip"
}

for ACTIMEO in default 1 15 60 300; do
    TAG="efs-readonly-actimeo-${ACTIMEO}"
    echo "=== Read-only sweep actimeo=${ACTIMEO} ==="

    mount_efs "$EFS_ID" "$ACTIMEO"
    copy_repo_to_efs
    REPO="${MOUNT_POINT}/chatticus"

    # Warmup (discarded for wall-time medians; iteration 1 is first measured post-remount)
    timed_git_status "$REPO" >/dev/null || true

    declare -a wall_times rpc_totals
    first_rpc_total=""
    iteration_json="["

    for i in $(seq 1 "$ITERATIONS"); do
        before="${RESULTS_DIR}/raw/${TAG}-iter${i}-before.rpc.json"
        after="${RESULTS_DIR}/raw/${TAG}-iter${i}-after.rpc.json"
        diff="${RESULTS_DIR}/raw/${TAG}-iter${i}-rpc-diff.txt"

        rpc_snapshot >"$before"
        wall="$(timed_git_status "$REPO")"
        rpc_snapshot >"$after"
        ALLOW_EMPTY_RPC_DELTA=1 diff_rpc "$before" "$after" "$diff" >/dev/null || true
        rpc_total="$(python3 - "$before" "$after" <<'PY'
import json, sys
from pathlib import Path
before = json.loads(Path(sys.argv[1]).read_text())
after = json.loads(Path(sys.argv[2]).read_text())
keys = set(before.get("ops", {})) | set(after.get("ops", {}))
print(sum(max(0, after.get("ops", {}).get(k, 0) - before.get("ops", {}).get(k, 0)) for k in keys))
PY
)"
        wall_times+=("$wall")
        rpc_totals+=("$rpc_total")
        if [ "$i" -eq 1 ]; then
            first_rpc_total="$rpc_total"
        fi
        if [ "$i" -gt 1 ]; then
            iteration_json+=","
        fi
        iteration_json+="$(python3 - "$i" "$wall" "$rpc_total" <<'PY'
import json, sys
print(json.dumps({"iteration": int(sys.argv[1]), "wall_seconds": float(sys.argv[2]), "rpc_ops_delta": int(sys.argv[3])}))
PY
)"
        echo "actimeo=${ACTIMEO} iter=${i} wall=${wall}s rpc_delta=${rpc_total}"
    done
    iteration_json+="]"

    # Medians for iterations 2..N (warm, no remount, no drop_caches)
    warm_walls=("${wall_times[@]:1}")
    warm_rpcs=("${rpc_totals[@]:1}")
    med_wall="$(median "${warm_walls[@]}")"
    med_rpc="$(median "${warm_rpcs[@]}")"
    first_wall="${wall_times[0]}"
    first_rpc="${rpc_totals[0]}"

    rpc_reduction_pct="$(python3 - "$first_rpc" "$med_rpc" <<'PY'
import sys
first, warm = float(sys.argv[1]), float(sys.argv[2])
if first <= 0:
    print("0")
else:
    print(f"{100.0 * (first - warm) / first:.1f}")
PY
)"

    cat >"${RESULTS_DIR}/raw/${TAG}.json" <<EOF
{
  "condition": "${TAG}",
  "actimeo": "${ACTIMEO}",
  "storage": "efs",
  "iterations": ${ITERATIONS},
  "first_post_remount": {
    "wall_seconds": ${first_wall},
    "rpc_ops_delta": ${first_rpc}
  },
  "warm_median": {
    "wall_seconds": ${med_wall},
    "rpc_ops_delta": ${med_rpc}
  },
  "rpc_reduction_pct_first_vs_warm_median": ${rpc_reduction_pct},
  "iterations_detail": ${iteration_json}
}
EOF

    umount "$MOUNT_POINT" || umount -l "$MOUNT_POINT" || true
    echo "${TAG}: first_rpc=${first_rpc} warm_med_rpc=${med_rpc} reduction=${rpc_reduction_pct}%"
done
