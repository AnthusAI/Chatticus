#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 <<'PY'
import json
import re
from pathlib import Path

results = Path("results")
raw = results / "raw"
ebs_path = raw / "ebs-control.json"
if not ebs_path.exists():
    raise SystemExit("missing ebs-control.json")

readonly_re = re.compile(r"^efs-readonly-actimeo-[^-]+\.json$")
mutating_re = re.compile(r"^efs-mutating-actimeo-[^-]+\.json$")

ebs = json.loads(ebs_path.read_text())["median_seconds"]
CHECKOUT_RESOLUTION = 0.01

def verdict(ratio):
    if ratio is None:
        return "n/a"
    if ratio <= 3.0:
        return "proceed (within ~3x)"
    if ratio <= 10.0:
        return "marginal (3-10x)"
    return "D1 fails for /workspace (>10x)"

def ratio(num, den):
    if den <= 0:
        return None
    return num / den

def ratio_overall(local_med, test_med):
    ops = []
    for op in ("git_status", "stat_sweep"):
        r = ratio(test_med[op], local_med[op])
        if r is not None:
            ops.append(r)
    if local_med["checkout"] >= CHECKOUT_RESOLUTION:
        r = ratio(test_med["checkout"], local_med["checkout"])
        if r is not None:
            ops.append(r)
    return max(ops) if ops else None

def fmt(v):
    return f"{v:.4f}"

readonly_rows = []
for path in sorted(raw.glob("efs-readonly-actimeo-*.json")):
    if not readonly_re.match(path.name):
        continue
    data = json.loads(path.read_text())
    actimeo = data["actimeo"]
    first = data["first_post_remount"]
    warm = data["warm_median"]
    ebs_git = ebs["git_status"]
    readonly_rows.append(
        {
            "actimeo": actimeo,
            "first_wall_s": first["wall_seconds"],
            "warm_wall_s": warm["wall_seconds"],
            "ratio_warm_vs_ebs": round(ratio(warm["wall_seconds"], ebs_git), 2),
            "first_rpc_delta": first["rpc_ops_delta"],
            "warm_rpc_delta": warm["rpc_ops_delta"],
            "rpc_reduction_pct": data.get("rpc_reduction_pct_first_vs_warm_median"),
            "cache_warm": warm["rpc_ops_delta"] < first["rpc_ops_delta"] * 0.5,
        }
    )

mutating_rows = []
for path in sorted(raw.glob("efs-mutating-actimeo-*.json")):
    if not mutating_re.match(path.name):
        continue
    data = json.loads(path.read_text())
    med = data["median_seconds"]
    overall = ratio_overall(ebs, med)
    row = {
        "actimeo": data["actimeo"],
        "median_seconds": med,
        "ratios_vs_ebs": {
            "git_status": round(ratio(med["git_status"], ebs["git_status"]), 2),
            "stat_sweep": round(ratio(med["stat_sweep"], ebs["stat_sweep"]), 2),
        },
        "ratio_overall": round(overall, 2) if overall else None,
        "verdict": verdict(overall),
    }
    if ebs["checkout"] >= CHECKOUT_RESOLUTION:
        row["ratios_vs_ebs"]["checkout"] = round(ratio(med["checkout"], ebs["checkout"]), 2)
    mutating_rows.append(row)

lab = json.loads((results / "lab-info.json").read_text()) if (results / "lab-info.json").exists() else {}
default_mut = next((r for r in mutating_rows if r["actimeo"] == "default"), mutating_rows[0] if mutating_rows else None)

checkout_note = ""
if ebs["checkout"] >= CHECKOUT_RESOLUTION:
    checkout_note = (
        f"EBS checkout median {ebs['checkout']:.4f}s is above timer resolution; "
        "`ratio_overall` includes checkout when it exceeds git_status and stat_sweep."
    )

readonly_doc = [
    "# Read-only git status sweep (EFS vs EBS)",
    "",
    "Repeated `git status` with **no mutation** between iterations. Remount between actimeo values.",
    "Warm medians use iterations 2–20 only. RPC deltas from mountstats/nfsstat per iteration.",
    "Cache warm when warm RPC median is **sharply below** first post-remount (not necessarily zero).",
    "",
    "| actimeo | 1st wall (s) | warm wall (s) | warm/Ebs git | 1st RPC | warm RPC | RPC reduction % | cache warm |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
]
for r in readonly_rows:
    readonly_doc.append(
        f"| {r['actimeo']} | {fmt(r['first_wall_s'])} | {fmt(r['warm_wall_s'])} | "
        f"{r['ratio_warm_vs_ebs']}x | {r['first_rpc_delta']} | {r['warm_rpc_delta']} | "
        f"{r['rpc_reduction_pct']}% | {r['cache_warm']} |"
    )

mutating_doc = [
    "# Mutating A0 sequence (EFS vs EBS)",
    "",
    "Separate from read-only timings. Warm-cache medians of full `run_ops` (status, checkout, stat, pip).",
    "`ratio_overall` = max(git_status, checkout, stat_sweep) — EBS checkout 0.0146s is above timer resolution.",
    "pip_install excluded from verdict. Thresholds vs **local EBS** on same instance.",
    "",
    "## EBS control",
    "",
    f"| git_status | checkout | stat_sweep | pip_install |",
    f"| {fmt(ebs['git_status'])} | {fmt(ebs['checkout'])} | {fmt(ebs['stat_sweep'])} | {fmt(ebs['pip_install'])} |",
    "",
    "## EFS by actimeo",
    "",
    "| actimeo | git_status | stat_sweep | ratio_overall | verdict |",
    "| --- | --- | --- | --- | --- |",
]
for r in mutating_rows:
    mutating_doc.append(
        f"| {r['actimeo']} | {r['ratios_vs_ebs']['git_status']}x | {r['ratios_vs_ebs']['stat_sweep']}x | "
        f"{r['ratio_overall']}x | {r['verdict']} |"
    )

headline = "No mutating results."
if default_mut:
    headline = (
        f"EFS in-VPC (default actimeo) mutating ratio_overall={default_mut['ratio_overall']}x vs EBS — "
        f"{default_mut['verdict']}. A0 WAN numbers are not used as in-VPC prediction."
    )

summary = [
    "# chatticus-3d5357 EFS in-VPC results",
    "",
    headline,
    checkout_note,
    "",
    f"EFS: `{lab.get('efs_id', 'unknown')}` in `{lab.get('vpc_id', 'unknown')}` / `{lab.get('subnet_id', 'unknown')}`",
    f"Seed files: {lab.get('seed_file_count', 'unknown')}",
    "",
    "See [readonly-actimeo.md](readonly-actimeo.md) and [mutating-actimeo.md](mutating-actimeo.md).",
    "",
]
(results / "summary.md").write_text("\n".join(summary) + "\n")
(results / "readonly-actimeo.md").write_text("\n".join(readonly_doc) + "\n")
(results / "mutating-actimeo.md").write_text("\n".join(mutating_doc) + "\n")

readme = [
    "# Results",
    "",
    f"Spike tag: **{lab.get('spike_tag', 'chatticus-3d5357')}**",
    f"EFS id: `{lab.get('efs_id', 'unknown')}` (throwaway; destroyed after run)",
    f"Instance: `{lab.get('instance_id', 'unknown')}`",
    "",
    headline,
    "",
    "Tables: [readonly-actimeo.md](readonly-actimeo.md), [mutating-actimeo.md](mutating-actimeo.md), [summary.md](summary.md).",
    "",
]
(results / "README.md").write_text("\n".join(readme) + "\n")

print(headline)
for r in mutating_rows:
    print(f"mutating actimeo={r['actimeo']} ratio_overall={r['ratio_overall']} verdict={r['verdict']}")
PY
