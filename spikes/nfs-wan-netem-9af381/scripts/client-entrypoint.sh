#!/bin/bash
set -euo pipefail

NETEM_DELAY_MS="${NETEM_DELAY_MS:-20}"

tc qdisc del dev eth0 root 2>/dev/null || true
tc qdisc add dev eth0 root netem delay "${NETEM_DELAY_MS}ms"

RTT="$(ping -c 3 172.28.0.2 2>/dev/null | tail -1 | awk -F'/' '{print $5}' || echo unknown)"
echo "netem delay=${NETEM_DELAY_MS}ms ping_median_rtt_ms=${RTT}"

exec sleep infinity
