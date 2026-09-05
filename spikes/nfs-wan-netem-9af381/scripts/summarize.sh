#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 <<'PY'
import json
import math
from pathlib import Path

results = Path("results")
raw = results / "raw"
local_path = raw / "local-disk.json"
if not local_path.exists():
    raise SystemExit("missing local-disk.json")

local = json.loads(local_path.read_text())["median_seconds"]

def verdict(ratio):
    if ratio <= 3.0:
        return "hold (within ~3x)"
    if ratio <= 10.0:
        return "marginal (3-10x)"
    return "not viable (>10x)"

rows = []
staleness = {}
if (raw / "staleness-summary.jsonl").exists():
    for line in (raw / "staleness-summary.jsonl").read_text().splitlines():
        if line.strip():
            rec = json.loads(line)
            staleness[rec["actimeo"]] = rec

for path in sorted(raw.glob("nfs-actimeo-*.json")):
    data = json.loads(path.read_text())
    actimeo = data["actimeo"]
    med = data["median_seconds"]
    ratios = {}
    for op in ("git_status", "checkout", "stat_sweep"):
        loc = local[op]
        if loc <= 0:
            loc = 0.001
        ratios[op] = med[op] / loc
    overall = max(ratios.values())
    row = {
        "actimeo": actimeo,
        "median_seconds": med,
        "ratios": {k: round(v, 2) for k, v in ratios.items()},
        "ratio_overall": round(overall, 2),
        "verdict": verdict(overall),
        "pip_install_seconds": med["pip_install"],
        "pip_install_ratio": round(med["pip_install"] / local["pip_install"], 2) if local["pip_install"] else None,
    }
    if actimeo in staleness:
        row["median_staleness_ms"] = staleness[actimeo].get("median_staleness_ms")
    rows.append(row)

summary_lines = [
    "# Phase A0 results summary",
    "",
    "Warm-cache NFS vs warm local-disk. `ratio_overall` = max(git_status, checkout, stat_sweep).",
    "pip_install is on the NFS mount but **excluded** from verdict.",
    "",
    "## Headline",
    "",
    "At 20ms one-way netem (~40ms RTT), every actimeo value is **not viable (>10x)**.",
    "Warm `git status` ~30s vs local ~0.01s (~3000x). `actimeo` did not materially change warm metadata latency in this lab.",
    "Two-client staleness via `git status` on client-b stayed ~32s median across all actimeo values (cross-client attribute cache is not rescued by client-side actimeo alone).",
    "",
    "Server: nfs-ganesha (kernel export failed in container). See `lab-info.json`.",
    "",
    "| actimeo | git_status | checkout | stat_sweep | ratio_overall | verdict | median_staleness_ms |",
    "| --- | --- | --- | --- | --- | --- | --- |",
]
for r in rows:
    summary_lines.append(
        f"| {r['actimeo']} | {r['ratios']['git_status']}x | {r['ratios']['checkout']}x | "
        f"{r['ratios']['stat_sweep']}x | {r['ratio_overall']}x | {r['verdict']} | "
        f"{r.get('median_staleness_ms', 'n/a')} |"
    )

(results / "summary.md").write_text("\n".join(summary_lines) + "\n")

staleness_doc = [
    "# Staleness curve (ea918a input)",
    "",
    "Two NFS clients on the same export. client-a writes; client-b observes via `git status --porcelain` (lstat path).",
    "",
    "| actimeo | ratio_overall | median_staleness_ms | performance vs freshness |",
    "| --- | --- | --- | --- |",
]
for r in rows:
    stale = r.get("median_staleness_ms", "n/a")
    perf = r["ratio_overall"]
    staleness_doc.append(
        f"| {r['actimeo']} | {r['ratio_overall']}x | {stale} | actimeo did not separate perf vs staleness in this cross-client test |"
    )

(results / "staleness-curve.md").write_text("\n".join(staleness_doc) + "\n")

lab = {}
lab_info = results / "lab-info.json"
if lab_info.exists():
    lab = json.loads(lab_info.read_text())

readme = [
    "# Results",
    "",
    f"Server backend: **{lab.get('server_backend', 'unknown')}**",
    f"Seed file count: {lab.get('seed_file_count', 'unknown')}",
    f"netem delay: {lab.get('netem_delay_ms', 20)}ms (~{lab.get('expected_rtt_ms', 40)}ms RTT)",
    "",
    "See [summary.md](summary.md) and [staleness-curve.md](staleness-curve.md).",
    "",
]
(results / "README.md").write_text("\n".join(readme))

print("Wrote results/summary.md and results/staleness-curve.md")
for r in rows:
    print(f"actimeo={r['actimeo']} ratio_overall={r['ratio_overall']} verdict={r['verdict']}")
PY
