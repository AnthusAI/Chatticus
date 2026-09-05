#!/bin/bash
set -euo pipefail

ACTIMEO="${1:-default}"
NFS_SERVER="${NFS_SERVER:-172.28.0.2}"
TRIALS="${TRIALS:-5}"
POLL_MS=100

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
vals = []
for a in sys.argv[1:]:
    if a.isdigit():
        vals.append(int(a))
if not vals:
    print("null")
    sys.exit(0)
vals.sort()
n = len(vals)
print(vals[n//2] if n % 2 else (vals[n//2-1] + vals[n//2]) // 2)
PY
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

remount_client client-a
remount_client client-b

staleness=()
for t in $(seq 1 "$TRIALS"); do
    marker="probe-${ACTIMEO}-t${t}-$(date +%s%N)"
    start_file="/results/raw/staleness-${ACTIMEO}-trial${t}.json"

    docker compose exec -T client-a bash -c "
        set -euo pipefail
        git config --global --add safe.directory /workspace/chatticus
        cd /workspace/chatticus
        start=\$(date +%s%N)
        echo '{\"marker\":\"${marker}\",\"start_ns\":'\"\$start\"'}' >'${start_file}'
        echo writer >'/workspace/chatticus/${marker}'
    "

    seen="$(docker compose exec -T client-b bash -c "
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
            sleep 0.1
        done
        echo timeout
    ")"

    echo "actimeo=${ACTIMEO} trial=${t} staleness_ms=${seen}"
    if [[ "$seen" =~ ^[0-9]+$ ]]; then
        staleness+=("$seen")
    fi
    docker compose exec -T client-a bash -c "rm -f '/workspace/chatticus/${marker}' '${start_file}'" || true
done

med="$(median_ms "${staleness[@]}")"
python3 - "$ACTIMEO" "$TRIALS" "$med" "${staleness[@]}" >>results/raw/staleness-summary.jsonl <<'PY'
import json, sys
actimeo, trials, med = sys.argv[1], int(sys.argv[2]), sys.argv[3]
samples = [int(x) for x in sys.argv[4:] if x.isdigit()]
med_val = int(med) if med.isdigit() else None
print(json.dumps({"actimeo": actimeo, "trials": trials, "median_staleness_ms": med_val, "samples": samples}))
PY

echo "Staleness actimeo=${ACTIMEO} median_ms=${med}"
