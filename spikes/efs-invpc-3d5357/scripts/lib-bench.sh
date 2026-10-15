#!/bin/bash
set -euo pipefail

MOUNT_POINT="${MOUNT_POINT:-/workspace}"

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

timed_git_status() {
    local repo="$1"
    timed_run git_status "cd '$repo' && git status >/dev/null"
}

rpc_snapshot() {
    python3 - "$MOUNT_POINT" <<'PY'
import json
import os
import re
import subprocess
import sys
from pathlib import Path

mount_point = sys.argv[1]
needle = f"mounted on {mount_point} with fstype nfs"
out = {"source": None, "ops": {}, "mount_point": mount_point}

mountstats = Path("/proc/self/mountstats")
if mountstats.exists():
    ops = {}
    in_nfs = False
    in_ops = False
    for line in mountstats.read_text().splitlines():
        if needle in line:
            in_nfs = True
            in_ops = False
            continue
        if in_nfs and line.startswith("device ") and mount_point not in line:
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
        print(json.dumps({"source": "nfsstat", "ops": ops, "mount_point": mount_point}))
        raise SystemExit(0)

print(json.dumps(out))
PY
}

rpc_total_ops() {
    python3 - "$1" <<'PY'
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text())
print(sum(data.get("ops", {}).values()))
PY
}

diff_rpc() {
    local before_file="$1"
    local after_file="$2"
    local out="$3"
    local allow_empty="${ALLOW_EMPTY_RPC_DELTA:-0}"
    python3 - "$before_file" "$after_file" "$out" "$allow_empty" <<'PY'
import json, sys
from pathlib import Path

before = json.loads(Path(sys.argv[1]).read_text())
after = json.loads(Path(sys.argv[2]).read_text())
out = Path(sys.argv[3])
allow_empty = sys.argv[4] == "1"
keys = set(before.get("ops", {})) | set(after.get("ops", {}))
delta = {}
for k in sorted(keys):
    d = after.get("ops", {}).get(k, 0) - before.get("ops", {}).get(k, 0)
    if d:
        delta[k] = d
lines = [f"{k}: {v}" for k, v in delta.items()]
out.write_text("\n".join(lines) + ("\n" if lines else ""))
if not delta and not allow_empty:
    src_b = before.get("source")
    src_a = after.get("source")
    raise SystemExit(f"empty RPC delta (before={src_b} after={src_a})")
print(sum(delta.values()) if delta else 0)
PY
}

mount_efs() {
    local efs_id="$1"
    local actimeo="${2:-default}"
    local opts="tls,nfsvers=4.1,timeo=600,retrans=2"
    if [ "$actimeo" != "default" ]; then
        opts="${opts},actimeo=${actimeo}"
    fi
    mkdir -p "$MOUNT_POINT"
    if mountpoint -q "$MOUNT_POINT"; then
        umount -l "$MOUNT_POINT" 2>/dev/null || umount "$MOUNT_POINT" || true
        sleep 1
    fi
    mount -t efs -o "$opts" "${efs_id}:/" "$MOUNT_POINT"
}

drop_caches() {
    sync
    echo 3 >/proc/sys/vm/drop_caches
}
