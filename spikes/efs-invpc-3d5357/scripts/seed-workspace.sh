#!/bin/bash
set -euo pipefail

LOCAL_POINT="${LOCAL_POINT:-/local-workspace}"
REPO_URL="${REPO_URL:-https://github.com/AnthusAI/Chatticus.git}"
REPO_BRANCH="${REPO_BRANCH:-develop}"
SPIKE_ROOT="${SPIKE_ROOT:-/opt/chatticus-spike}"

echo "Seeding workspace on EBS at ${LOCAL_POINT}..."

mkdir -p "${LOCAL_POINT}"

if [ -d "${LOCAL_POINT}/chatticus/.git" ]; then
    echo "Workspace already seeded; skipping clone."
else
    rm -rf "${LOCAL_POINT}/chatticus"
    git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "${LOCAL_POINT}/chatticus"
    cd "${LOCAL_POINT}/chatticus"
    git config user.email "spike@chatticus.local"
    git config user.name "efs-invpc-spike"
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

mkdir -p "${LOCAL_POINT}/.pip-scratch"
cp -r "${SPIKE_ROOT}/fixtures/small-pip" "${LOCAL_POINT}/small-pip"

FILE_COUNT="$(find "${LOCAL_POINT}/chatticus" -type f 2>/dev/null | wc -l | tr -d ' ')"

RESULTS_DIR="${SPIKE_ROOT}/results"
mkdir -p "${RESULTS_DIR}/raw"

python3 - "$RESULTS_DIR" "$FILE_COUNT" "$REPO_URL" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

results = Path(sys.argv[1])
file_count = int(sys.argv[2])
repo_url = sys.argv[3]
lab_path = results / "lab-info.json"
partial = results / "lab-info-partial.json"
lab = {}
if partial.exists():
    lab.update(json.loads(partial.read_text()))
lab.update(
    {
        "seed_file_count": file_count,
        "seed_repo_url": repo_url,
        "seeded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fixture": "same as nfs-wan-netem-9af381 (bench-a/bench-b)",
    }
)
lab_path.write_text(json.dumps(lab, indent=2) + "\n")
print(f"Seed complete. files={file_count}")
PY
