#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NFS_SERVER="${NFS_SERVER:-172.28.0.2}"
NETEM_DELAY_MS="${NETEM_DELAY_MS:-20}"

measure_container() {
    local container="$1"
    docker compose exec -T "$container" bash -c "ping -c 5 ${NFS_SERVER} 2>/dev/null | tail -1" \
        | awk -F'/' '{ if (NF >= 5) print $5; else print "unknown" }'
}

echo "Removing netem for LAN RTT sample..."
docker compose exec -T client-a bash -c "tc qdisc del dev eth0 root 2>/dev/null || true" >/dev/null
LAN_RTT="$(measure_container client-a || echo unknown)"

echo "Applying netem ${NETEM_DELAY_MS}ms for WAN RTT sample..."
docker compose exec -T client-a bash -c "
    tc qdisc del dev eth0 root 2>/dev/null || true
    tc qdisc add dev eth0 root netem delay ${NETEM_DELAY_MS}ms
" >/dev/null
WAN_RTT="$(measure_container client-a || echo unknown)"

python3 - "$LAN_RTT" "$WAN_RTT" "$NETEM_DELAY_MS" <<'PY'
import json
import sys
from pathlib import Path

lan, wan, delay = sys.argv[1:4]
path = Path("results/lab-info.json")
lab = {}
if path.exists():
    lab = json.loads(path.read_text())

def to_float(v):
    try:
        return float(v)
    except ValueError:
        return None

lab["netem_delay_ms"] = int(delay)
lab["measured_ping_rtt_ms"] = {
    "lan_no_netem": to_float(lan),
    "wan_with_netem": to_float(wan),
}
lab["expected_rtt_ms"] = int(delay) * 2
path.write_text(json.dumps(lab, indent=2) + "\n")
print(f"lab-info: LAN RTT={lan}ms WAN RTT={wan}ms (netem {delay}ms one-way)")
PY
