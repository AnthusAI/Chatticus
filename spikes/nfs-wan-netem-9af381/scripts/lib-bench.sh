#!/bin/bash
set -euo pipefail

median() {
    python3 - "$@" <<'PY'
import sys
vals = sorted(float(x) for x in sys.argv[1:])
n = len(vals)
if n == 0:
    print("0")
elif n % 2:
    print(vals[n // 2])
else:
    print((vals[n // 2 - 1] + vals[n // 2]) / 2)
PY
}

timed_run() {
    local label="$1"
    shift
    python3 - "$@" <<'PY'
import subprocess, sys, time
cmd = sys.argv[1]
start = time.perf_counter()
subprocess.run(
    ["bash", "-c", f"git config --global --add safe.directory '*' 2>/dev/null; {cmd}"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
print(f"{time.perf_counter() - start:.4f}")
PY
}

run_ops() {
    local repo="$1"
    local pip_dest="$2"
    local git_status checkout stat_sweep pip_install

    git_status="$(timed_run git_status "cd '$repo' && git status >/dev/null")"
    checkout="$(timed_run checkout "cd '$repo' && git checkout bench-a >/dev/null && git checkout bench-b >/dev/null")"
    stat_sweep="$(timed_run stat_sweep "cd '$repo' && find . -type f -print0 | xargs -0 stat >/dev/null")"
    pip_install="$(timed_run pip_install "pip install --no-cache-dir -q -r '$repo/../small-pip/requirements.txt' -t '$pip_dest'")"

    echo "${git_status} ${checkout} ${stat_sweep} ${pip_install}"
}

rpc_snapshot() {
    python3 <<'PY'
import json
import re
import subprocess
from pathlib import Path

out = {"source": None, "ops": {}}

mountstats = Path("/proc/self/mountstats")
if mountstats.exists():
    ops = {}
    in_nfs = False
    in_ops = False
    for line in mountstats.read_text().splitlines():
        if "mounted on /workspace with fstype nfs" in line:
            in_nfs = True
            in_ops = False
            continue
        if in_nfs and line.startswith("device ") and "/workspace" not in line:
            break
        if in_nfs and "per-op statistics" in line:
            in_ops = True
            continue
        if in_nfs and in_ops:
            m = re.match(r"\s+(\S+):\s+(\d+)", line)
            if m:
                ops[m.group(1).rstrip(":")] = int(m.group(2))
            elif line.strip() == "":
                continue
            elif not line.startswith("\t"):
                break
    if ops:
        out["source"] = "mountstats"
        out["ops"] = ops
        print(json.dumps(out))
        raise SystemExit(0)

nfs4 = Path("/proc/net/rpc/nfs4")
if nfs4.exists():
    ops = {}
    for line in nfs4.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].endswith(":"):
            key = parts[0].rstrip(":")
            try:
                ops[key] = int(parts[1])
            except ValueError:
                pass
    if ops:
        out["source"] = "proc_net_rpc_nfs4"
        out["ops"] = ops
        print(json.dumps(out))
        raise SystemExit(0)

try:
    text = subprocess.check_output(["nfsstat", "-c"], stderr=subprocess.DEVNULL, text=True)
except (subprocess.CalledProcessError, FileNotFoundError):
    text = ""
if text.strip():
    ops = {}
    for line in text.splitlines():
        m = re.match(r"\s*(\S+):\s*(\d+)", line)
        if m:
            ops[m.group(1)] = int(m.group(2))
    if ops:
        print(json.dumps({"source": "nfsstat", "ops": ops}))
        raise SystemExit(0)

print(json.dumps({"source": "none", "ops": {}}))
PY
}

diff_rpc() {
    local before_file="$1"
    local after_file="$2"
    local out="$3"
    python3 - "$before_file" "$after_file" "$out" <<'PY'
import json, sys
from pathlib import Path

before = json.loads(Path(sys.argv[1]).read_text())
after = json.loads(Path(sys.argv[2]).read_text())
out = Path(sys.argv[3])
keys = set(before.get("ops", {})) | set(after.get("ops", {}))
delta = {}
for k in sorted(keys):
    d = after.get("ops", {}).get(k, 0) - before.get("ops", {}).get(k, 0)
    if d:
        delta[k] = d
lines = [f"{k}: {v}" for k, v in delta.items()]
out.write_text("\n".join(lines) + ("\n" if lines else ""))
if not delta:
    src_b = before.get("source")
    src_a = after.get("source")
    raise SystemExit(f"empty RPC delta (before={src_b} after={src_a})")
PY
}

nfsstat_snapshot() { rpc_snapshot; }
diff_nfsstat() { diff_rpc "$@"; }
