#!/bin/bash
# Recompute first_post_remount and warm_median from iterations_detail (no lab re-run).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 <<'PY'
import json
import re
import statistics
from pathlib import Path

raw = Path("results/raw")
pattern = re.compile(r"^efs-readonly-actimeo-[^-]+\.json$")

def median(vals):
    vals = sorted(vals)
    n = len(vals)
    if n == 0:
        return 0.0
    if n % 2:
        return vals[n // 2]
    return (vals[n // 2 - 1] + vals[n // 2]) / 2

for path in sorted(raw.glob("efs-readonly-actimeo-*.json")):
    if not pattern.match(path.name):
        continue
    data = json.loads(path.read_text())
    detail = data.get("iterations_detail")
    if not detail:
        raise SystemExit(f"missing iterations_detail in {path.name}")
    first = detail[0]
    warm_detail = detail[1:]
    warm_wall = median([d["wall_seconds"] for d in warm_detail])
    warm_rpc = median([d["rpc_ops_delta"] for d in warm_detail])
    first_rpc = first["rpc_ops_delta"]
    reduction = (
        round(100.0 * (first_rpc - warm_rpc) / first_rpc, 1) if first_rpc > 0 else 0.0
    )
    data["first_post_remount"] = {
        "wall_seconds": first["wall_seconds"],
        "rpc_ops_delta": first["rpc_ops_delta"],
    }
    data["warm_median"] = {
        "wall_seconds": warm_wall,
        "rpc_ops_delta": warm_rpc,
    }
    data["rpc_reduction_pct_first_vs_warm_median"] = reduction
    path.write_text(json.dumps(data, indent=2) + "\n")
    print(
        f"{path.name}: first={first['wall_seconds']}/{first['rpc_ops_delta']} "
        f"warm_med={warm_wall}/{warm_rpc} reduction={reduction}%"
    )
PY

bash "${ROOT}/scripts/summarize.sh"
