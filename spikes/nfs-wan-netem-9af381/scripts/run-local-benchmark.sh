#!/bin/bash
set -euo pipefail

source /scripts/lib-bench.sh

REPO="/local-workspace/chatticus"
PIP_DEST="/local-workspace/.pip-scratch"
RUNS=3
TAG="local-disk"

if [ ! -d "$REPO/.git" ]; then
    echo "ERROR: $REPO missing"
    exit 1
fi

mkdir -p /results/raw

drop_caches() {
    sync
    echo 3 >/proc/sys/vm/drop_caches
}

drop_caches
run_ops "$REPO" "$PIP_DEST" >/dev/null || true

declare -a gs cs ss ps
for i in $(seq 1 "$RUNS"); do
    read -r g c s p <<<"$(run_ops "$REPO" "$PIP_DEST")"
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
  "actimeo": "n/a",
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
