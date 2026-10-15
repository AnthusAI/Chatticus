#!/bin/bash
set -euo pipefail

SPIKE_ROOT="${SPIKE_ROOT:-/opt/chatticus-spike}"
LOCAL_POINT="${LOCAL_POINT:-/local-workspace}"
MOUNT_POINT="${MOUNT_POINT:-/workspace}"
EFS_ID="${EFS_ID:?EFS_ID required}"
RUNS="${MUTATING_RUNS:-3}"

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
    TAG="efs-mutating-actimeo-${ACTIMEO}"
    echo "=== Mutating sweep actimeo=${ACTIMEO} ==="

    mount_efs "$EFS_ID" "$ACTIMEO"
    copy_repo_to_efs
    REPO="${MOUNT_POINT}/chatticus"
    PIP_DEST="${MOUNT_POINT}/.pip-scratch"

    drop_caches
    run_ops "$REPO" "$PIP_DEST" >/dev/null || true

    declare -a gs cs ss ps
    for i in $(seq 1 "$RUNS"); do
        before="${RESULTS_DIR}/raw/${TAG}-run${i}-before.rpc.json"
        after="${RESULTS_DIR}/raw/${TAG}-run${i}-after.rpc.json"
        rpc_snapshot >"$before"
        read -r g c s p <<<"$(run_ops "$REPO" "$PIP_DEST")"
        rpc_snapshot >"$after"
        diff_rpc "$before" "$after" "${RESULTS_DIR}/raw/${TAG}-run${i}-rpc-diff.txt"
        gs+=("$g")
        cs+=("$c")
        ss+=("$s")
        ps+=("$p")
    done

    mg="$(median "${gs[@]}")"
    mc="$(median "${cs[@]}")"
    ms="$(median "${ss[@]}")"
    mp="$(median "${ps[@]}")"

    cat >"${RESULTS_DIR}/raw/${TAG}.json" <<EOF
{
  "condition": "${TAG}",
  "actimeo": "${ACTIMEO}",
  "storage": "efs",
  "host": "$(hostname)",
  "runs": ${RUNS},
  "median_seconds": {
    "git_status": ${mg},
    "checkout": ${mc},
    "stat_sweep": ${ms},
    "pip_install": ${mp}
  }
}
EOF

    umount "$MOUNT_POINT" || umount -l "$MOUNT_POINT" || true
    echo "${TAG}: git_status=${mg}s checkout=${mc}s stat_sweep=${ms}s pip_install=${mp}s"
done
