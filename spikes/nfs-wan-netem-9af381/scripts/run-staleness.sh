#!/bin/bash
set -euo pipefail

ACTIMEO="${1:-default}"
NFS_SERVER="${NFS_SERVER:-172.28.0.2}"
STAT_TRIALS="${STAT_TRIALS:-5}"
POLL_SEC="0.1"

mount_opts() {
    local opts="vers=4.1,timeo=600,retrans=2"
    if [ "$ACTIMEO" != "default" ]; then
        opts="${opts},actimeo=${ACTIMEO}"
    fi
    echo "$opts"
}

remount_client() {
    local container="$1"
    docker compose exec -T "$container" bash -c "
        set -euo pipefail
        mkdir -p /workspace
        mountpoint -q /workspace && umount -l /workspace 2>/dev/null || umount /workspace 2>/dev/null || true
        sleep 1
        mount -t nfs -o '$(mount_opts)' ${NFS_SERVER}:/exports/workspace /workspace
    "
}

median_ms() {
    python3 - "$@" <<'PY'
import sys
vals = [int(x) for x in sys.argv[1:] if x.isdigit()]
if not vals:
    print("null")
    sys.exit(0)
vals.sort()
n = len(vals)
print(vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) // 2)
PY
}


ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

remount_client client-a
remount_client client-b

stat_samples=()
for t in $(seq 1 "$STAT_TRIALS"); do
    marker="probe-${ACTIMEO}-stat-t${t}-$(date +%s%N)"
    marker_path="/workspace/chatticus/${marker}"
    start_file="/results/raw/staleness-${ACTIMEO}-stat-trial${t}.json"

    docker compose exec -T client-a bash -c "
        set -euo pipefail
        start=\$(date +%s%N)
        echo '{\"marker\":\"${marker}\",\"start_ns\":'\"\$start\"'}' >'${start_file}'
        echo writer >'${marker_path}'
    "

    seen="$(docker compose exec -T client-b bash -c "
        set -euo pipefail
        start=\$(python3 -c \"import json; print(json.load(open('${start_file}'))['start_ns'])\")
        marker_path='${marker_path}'
        for _ in \$(seq 1 600); do
            if stat \"\$marker_path\" >/dev/null 2>&1; then
                now=\$(date +%s%N)
                echo \$(( (now - start) / 1000000 ))
                exit 0
            fi
            sleep ${POLL_SEC}
        done
        echo timeout
    ")"

    echo "actimeo=${ACTIMEO} probe=stat trial=${t} staleness_ms=${seen}"
    if [[ "$seen" =~ ^[0-9]+$ ]]; then
        stat_samples+=("$seen")
    fi
    docker compose exec -T client-a bash -c "rm -f '${marker_path}' '${start_file}'" || true
done

stat_med="$(median_ms "${stat_samples[@]}")"
python3 - "$ACTIMEO" "$STAT_TRIALS" "$stat_med" "${stat_samples[@]}" >>results/raw/staleness-summary.jsonl <<'PY'
import json, sys
actimeo, trials, med = sys.argv[1], int(sys.argv[2]), sys.argv[3]
samples = [int(x) for x in sys.argv[4:] if x.isdigit()]
med_val = int(med) if med.isdigit() else None
print(json.dumps({
    "actimeo": actimeo,
    "probe": "stat",
    "trials": trials,
    "median_staleness_ms": med_val,
    "samples": samples,
}))
PY

# Contrast: one git status trial (confounded; labeled)
marker="probe-${ACTIMEO}-git-t1-$(date +%s%N)"
marker_path="/workspace/chatticus/${marker}"
start_file="/results/raw/staleness-${ACTIMEO}-git-trial1.json"

docker compose exec -T client-a bash -c "
    set -euo pipefail
    start=\$(date +%s%N)
    echo '{\"marker\":\"${marker}\",\"start_ns\":'\"\$start\"'}' >'${start_file}'
    echo writer >'${marker_path}'
"

git_seen="$(docker compose exec -T client-b bash -c "
    set -euo pipefail
    git config --global --add safe.directory /workspace/chatticus
    cd /workspace/chatticus
    start=\$(python3 -c \"import json; print(json.load(open('${start_file}'))['start_ns'])\")
    marker='${marker}'
    for _ in \$(seq 1 600); do
        if git status --porcelain 2>/dev/null | grep -q \"\$marker\"; then
            now=\$(date +%s%N)
            echo \$(( (now - start) / 1000000 ))
            exit 0
        fi
        sleep ${POLL_SEC}
    done
    echo timeout
")"

echo "actimeo=${ACTIMEO} probe=git_status(contrast) trial=1 staleness_ms=${git_seen}"
python3 - "$ACTIMEO" "$git_seen" >>results/raw/staleness-summary.jsonl <<'PY'
import json, sys
actimeo, seen = sys.argv[1], sys.argv[2]
print(json.dumps({
    "actimeo": actimeo,
    "probe": "git_status",
    "note": "contrast only — confounded by git status runtime",
    "trials": 1,
    "median_staleness_ms": int(seen) if seen.isdigit() else None,
    "samples": [int(seen)] if seen.isdigit() else [],
}))
PY

docker compose exec -T client-a bash -c "rm -f '${marker_path}' '${start_file}'" || true

echo "Staleness actimeo=${ACTIMEO} stat_median_ms=${stat_med} git_contrast_ms=${git_seen}"
