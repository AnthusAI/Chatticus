#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 <<'PY'
import json
from pathlib import Path

results = Path("results")
raw = results / "raw"
local_path = raw / "local-disk.json"
lan_path = raw / "nfs-lan.json"
if not local_path.exists():
    raise SystemExit("missing local-disk.json")
if not lan_path.exists():
    raise SystemExit("missing nfs-lan.json (LAN NFS control)")

local = json.loads(local_path.read_text())["median_seconds"]
lan = json.loads(lan_path.read_text())["median_seconds"]

CHECKOUT_RESOLUTION = 0.01

def verdict(ratio):
    if ratio <= 3.0:
        return "hold (within ~3x)"
    if ratio <= 10.0:
        return "marginal (3-10x)"
    return "not viable (>10x)"

def fmt_sec(v):
    return f"{v:.4f}"

def ratio(num, den):
    if den <= 0:
        return None
    return num / den

def ratio_overall(local_med, netem_med):
    ops = []
    for op in ("git_status", "stat_sweep"):
        r = ratio(netem_med[op], local_med[op])
        if r is not None:
            ops.append(r)
    if local_med["checkout"] >= CHECKOUT_RESOLUTION:
        r = ratio(netem_med["checkout"], local_med["checkout"])
        if r is not None:
            ops.append(r)
    return max(ops) if ops else None

staleness = {}
if (raw / "staleness-summary.jsonl").exists():
    for line in (raw / "staleness-summary.jsonl").read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get("probe") == "stat":
            staleness[rec["actimeo"]] = rec

rows = []
for path in sorted(raw.glob("nfs-actimeo-*.json")):
    if "-run" in path.name:
        continue
    data = json.loads(path.read_text())
    actimeo = data["actimeo"]
    med = data["median_seconds"]
    overall = ratio_overall(local, med)
    row = {
        "actimeo": actimeo,
        "median_seconds": med,
        "ratios_vs_local": {
            "git_status": round(ratio(med["git_status"], local["git_status"]), 2),
            "stat_sweep": round(ratio(med["stat_sweep"], local["stat_sweep"]), 2),
        },
        "ratio_overall": round(overall, 2) if overall else None,
        "verdict": verdict(overall) if overall else "n/a",
    }
    if local["checkout"] >= CHECKOUT_RESOLUTION:
        row["ratios_vs_local"]["checkout"] = round(ratio(med["checkout"], local["checkout"]), 2)
    if actimeo in staleness:
        row["median_staleness_stat_ms"] = staleness[actimeo].get("median_staleness_ms")
    rows.append(row)

default_wan = next((r for r in rows if r["actimeo"] == "default"), rows[0] if rows else None)
wan_med = default_wan["median_seconds"] if default_wan else {}

lab = json.loads((results / "lab-info.json").read_text()) if (results / "lab-info.json").exists() else {}
ping = lab.get("measured_ping_rtt_ms", {})

checkout_note = ""
if local["checkout"] < CHECKOUT_RESOLUTION:
    checkout_note = (
        f"Local checkout median {local['checkout']:.4f}s is below {CHECKOUT_RESOLUTION}s timer resolution; "
        "`ratio_overall` uses max(git_status, stat_sweep) only."
    )

lan_git = lan["git_status"]
wan_git = wan_med.get("git_status", 0)
netem_tax = wan_git - lan_git if wan_git and lan_git else None

if lan_git > 10:
    wan_headline = (
        f"LAN NFS git_status {lan_git:.2f}s vs netem {wan_git:.2f}s — most overhead is **container/Ganesha**, not WAN delay."
    )
elif netem_tax and netem_tax > 5:
    lan_vs_local = lan_git / local["git_status"] if local["git_status"] > 0 else None
    lan_note = f" LAN alone vs local ~{lan_vs_local:.0f}x (marginal band)." if lan_vs_local else ""
    wan_headline = (
        f"LAN NFS git_status {lan_git:.2f}s vs netem {wan_git:.2f}s — WAN netem adds ~{netem_tax:.1f}s.{lan_note}"
        " Stat-based cross-client staleness ~0.75–0.83s; actimeo did not materially separate it."
    )
else:
    wan_headline = f"LAN NFS git_status {lan_git:.2f}s vs netem {wan_git:.2f}s."

summary_lines = [
    "# Phase A0 results summary",
    "",
    "Warm-cache medians. `ratio_overall` = max(git_status, stat_sweep) when local checkout is below timer resolution.",
    "pip_install excluded from verdict.",
    "",
    "## Wall seconds (default actimeo, warm cache)",
    "",
    "| condition | git_status | checkout | stat_sweep | pip_install |",
    "| --- | --- | --- | --- | --- |",
    f"| local disk | {fmt_sec(local['git_status'])} | {fmt_sec(local['checkout'])} | {fmt_sec(local['stat_sweep'])} | {fmt_sec(local['pip_install'])} |",
    f"| NFS LAN (no netem) | {fmt_sec(lan['git_status'])} | {fmt_sec(lan['checkout'])} | {fmt_sec(lan['stat_sweep'])} | {fmt_sec(lan['pip_install'])} |",
]
if default_wan:
    summary_lines.append(
        f"| NFS WAN (netem 20ms) | {fmt_sec(wan_med['git_status'])} | {fmt_sec(wan_med['checkout'])} | {fmt_sec(wan_med['stat_sweep'])} | {fmt_sec(wan_med['pip_install'])} |"
    )

summary_lines.extend([
    "",
    f"Measured ping RTT: LAN {ping.get('lan_no_netem', 'n/a')} ms, WAN {ping.get('wan_with_netem', 'n/a')} ms (see `lab-info.json`).",
    "",
    "## Headline",
    "",
    wan_headline,
    checkout_note,
    "",
    f"Server: {lab.get('server_backend', 'unknown')} (see `lab-info.json`).",
    "",
    "## Ratios vs local (netem, by actimeo)",
    "",
    "| actimeo | git_status | stat_sweep | ratio_overall | verdict | stat staleness ms |",
    "| --- | --- | --- | --- | --- | --- |",
])
for r in rows:
    summary_lines.append(
        f"| {r['actimeo']} | {r['ratios_vs_local']['git_status']}x | {r['ratios_vs_local']['stat_sweep']}x | "
        f"{r['ratio_overall']}x | {r['verdict']} | {r.get('median_staleness_stat_ms', 'n/a')} |"
    )

(results / "summary.md").write_text("\n".join(summary_lines) + "\n")

staleness_doc = [
    "# Staleness curve (ea918a input)",
    "",
    "Two NFS clients. client-a creates a marker file; client-b polls with **`stat`** (100ms loop).",
    "One **`git status --porcelain`** trial per actimeo is contrast-only (confounded by ~30s git runtime).",
    "",
    "| actimeo | ratio_overall (WAN) | stat staleness ms | git_status contrast ms |",
    "| --- | --- | --- | --- |",
]
git_contrast = {}
if (raw / "staleness-summary.jsonl").exists():
    for line in (raw / "staleness-summary.jsonl").read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get("probe") == "git_status":
            git_contrast[rec["actimeo"]] = rec.get("median_staleness_ms")

for r in rows:
    stale = r.get("median_staleness_stat_ms", "n/a")
    git_c = git_contrast.get(r["actimeo"], "n/a")
    staleness_doc.append(
        f"| {r['actimeo']} | {r['ratio_overall']}x | {stale} | {git_c} (contrast) |"
    )

(results / "staleness-curve.md").write_text("\n".join(staleness_doc) + "\n")

readme = [
    "# Results",
    "",
    f"Server backend: **{lab.get('server_backend', 'unknown')}**",
    f"Seed file count: {lab.get('seed_file_count', 'unknown')}",
    f"Measured RTT (ms): LAN {ping.get('lan_no_netem')} / WAN {ping.get('wan_with_netem')}",
    "",
    "Committed timing JSON: `raw/local-disk.json`, `raw/nfs-lan.json`, `raw/nfs-actimeo-*.json`.",
    "",
    "See [summary.md](summary.md) and [staleness-curve.md](staleness-curve.md).",
    "",
]
(results / "README.md").write_text("\n".join(readme) + "\n")

print("Wrote results/summary.md and results/staleness-curve.md")
for r in rows:
    print(f"actimeo={r['actimeo']} ratio_overall={r['ratio_overall']} verdict={r['verdict']}")
PY
