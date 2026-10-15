#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Seeding workspace on NFS export..."

REPO_URL="${REPO_URL:-https://github.com/AnthusAI/Chatticus.git}"
REPO_BRANCH="${REPO_BRANCH:-develop}"

if [ -d /exports/workspace/chatticus/.git ]; then
    echo "Workspace already seeded; skipping clone."
else
    rm -rf /exports/workspace/chatticus
    git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" /exports/workspace/chatticus
    cd /exports/workspace/chatticus
    git config user.email "spike@chatticus.local"
    git config user.name "nfs-wan-netem-spike"
    git checkout -B bench-a
    echo "bench-a marker" >>.bench-marker
    git add .bench-marker
    git commit -m "bench-a" || true
    git checkout -B bench-b
    echo "bench-b marker" >>.bench-marker
    git add .bench-marker
    git commit -m "bench-b" || true
    git checkout bench-a
    rm -rf node_modules .venv web/node_modules infra/node_modules 2>/dev/null || true
    find . -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
    find . -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
fi

mkdir -p /exports/workspace/.pip-scratch
cp -r /fixtures/small-pip /exports/workspace/small-pip

BACKEND="unknown"
if [ -f /exports/.nfs-backend ]; then
    BACKEND="$(cat /exports/.nfs-backend)"
fi

FILE_COUNT="$(find /exports/workspace/chatticus -type f 2>/dev/null | wc -l | tr -d ' ')"

mkdir -p /results/raw
cat >/results/lab-info.json <<EOF
{
  "server_backend": "${BACKEND}",
  "netem_delay_ms": 20,
  "expected_rtt_ms": 40,
  "nfs_version": "4.1",
  "seed_file_count": ${FILE_COUNT},
  "seed_repo_url": "${REPO_URL}",
  "seeded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "Seed complete. backend=${BACKEND} files=${FILE_COUNT}"
