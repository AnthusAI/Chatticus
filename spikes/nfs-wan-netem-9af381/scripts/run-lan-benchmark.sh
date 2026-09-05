#!/bin/bash
set -euo pipefail

NFS_SERVER="${NFS_SERVER:-172.28.0.2}"
MOUNT_POINT="${MOUNT_POINT:-/workspace}"

source /scripts/lib-bench.sh

do_mount() {
    mkdir -p "$MOUNT_POINT"
    if mountpoint -q "$MOUNT_POINT"; then
        umount -l "$MOUNT_POINT" 2>/dev/null || umount "$MOUNT_POINT" || true
        sleep 1
    fi
    mount -t nfs -o vers=4.1,timeo=600,retrans=2 "${NFS_SERVER}:/exports/workspace" "$MOUNT_POINT"
}

REPO="${MOUNT_POINT}/chatticus"
PIP_DEST="${MOUNT_POINT}/.pip-scratch"
RUNS=3
TAG="nfs-lan"

mkdir -p /results/raw
do_mount
echo "Benchmark ${TAG} on $(hostname) (no netem)"

drop_caches() {
    sync
    echo 3 >/proc/sys/vm/drop_caches
}

drop_caches
run_ops "$REPO" "$PIP_DEST" >/dev/null || true

declare -a gs cs ss ps
for i in $(seq 1 "$RUNS"); do
    before="/results/raw/${TAG}-run${i}-before.rpc.json"
    after="/results/raw/${TAG}-run${i}-after.rpc.json"
    rpc_snapshot >"$before"
    read -r g c s p <<<"$(run_ops "$REPO" "$PIP_DEST")"
    rpc_snapshot >"$after"
    diff_rpc "$before" "$after" "/results/raw/${TAG}-run${i}-rpc-diff.txt"
    gs+=("$g")
    cs+=("$c")
    ss+=("$s")
    ps+=("$p")
done

mg="$(median "${gs[@]}")"
mc="$(median "${cs[@]}")"
ms="$(median "${ss[@]}")"
mp="$(median "${ps[@]}")"

cat >/results/raw/${TAG}.json <<EOF
{
  "condition": "${TAG}",
  "actimeo": "default",
  "netem": false,
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

echo "${TAG}: git_status=${mg}s checkout=${mc}s stat_sweep=${ms}s pip_install=${mp}s"
