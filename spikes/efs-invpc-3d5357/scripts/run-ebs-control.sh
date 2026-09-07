#!/bin/bash
set -euo pipefail

SPIKE_ROOT="${SPIKE_ROOT:-/opt/chatticus-spike}"
LOCAL_POINT="${LOCAL_POINT:-/local-workspace}"
RUNS="${MUTATING_RUNS:-3}"
TAG="ebs-control"

# shellcheck source=scripts/lib-bench.sh
source "${SPIKE_ROOT}/scripts/lib-bench.sh"

REPO="${LOCAL_POINT}/chatticus"
PIP_DEST="${LOCAL_POINT}/.pip-scratch"
RESULTS_DIR="${SPIKE_ROOT}/results"

if [ ! -d "$REPO/.git" ]; then
    echo "ERROR: ${REPO} missing; run seed-workspace.sh first"
    exit 1
fi

mkdir -p "${RESULTS_DIR}/raw"

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

cat >"${RESULTS_DIR}/raw/${TAG}.json" <<EOF
{
  "condition": "${TAG}",
  "actimeo": "n/a",
  "storage": "ebs",
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
