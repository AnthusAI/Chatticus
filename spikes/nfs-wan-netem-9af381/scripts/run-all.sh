#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

chmod +x scripts/*.sh docker/nfs-server/*.sh 2>/dev/null || true

echo "=== Build images ==="
docker compose build

echo "=== Start NFS server ==="
docker compose up -d nfs-server
echo "Waiting for NFS server health..."
for i in $(seq 1 60); do
    if docker compose ps nfs-server 2>/dev/null | grep -q healthy; then
        echo "NFS server healthy"
        break
    fi
    sleep 2
    if [ "$i" -eq 60 ]; then
        echo "ERROR: NFS server not healthy"
        docker compose logs nfs-server | tail -50
        exit 1
    fi
done

echo "=== Seed workspace ==="
docker compose run --rm seed

echo "=== Start clients ==="
docker compose up -d client-a client-b local-control
sleep 5

echo "=== Measure ping RTT ==="
bash scripts/measure-rtt.sh

echo "=== Local disk baseline ==="
docker compose exec -T local-control bash /scripts/run-local-benchmark.sh

echo "=== LAN NFS control (no netem) ==="
docker compose exec -T client-a bash -c "tc qdisc del dev eth0 root 2>/dev/null || true"
docker compose exec -T client-a bash /scripts/run-lan-benchmark.sh

echo "=== Re-apply netem for WAN benchmarks ==="
docker compose exec -T client-a bash -c "
    tc qdisc del dev eth0 root 2>/dev/null || true
    tc qdisc add dev eth0 root netem delay 20ms
"

for ACTIMEO in default 1 15 60 300; do
    echo "=== NFS WAN benchmark actimeo=${ACTIMEO} ==="
    docker compose exec -T client-a bash /scripts/run-nfs-benchmark.sh "$ACTIMEO"
done

: >results/raw/staleness-summary.jsonl
for ACTIMEO in default 1 15 60 300; do
    echo "=== Staleness actimeo=${ACTIMEO} ==="
    bash scripts/run-staleness.sh "$ACTIMEO"
done

echo "=== Summarize ==="
bash scripts/summarize.sh

echo "=== Done ==="
