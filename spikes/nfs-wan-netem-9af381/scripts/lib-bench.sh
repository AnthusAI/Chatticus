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
    local out
    out="$( { /usr/bin/time -p bash -c "git config --global --add safe.directory '*' 2>/dev/null; $*" ; } 2>&1 )"
    local real
    real="$(echo "$out" | awk '/^real /{print $2}')"
    echo "$real"
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

nfsstat_snapshot() {
    nfsstat -c 2>/dev/null || echo "nfsstat unavailable"
}

diff_nfsstat() {
    local before_file="$1"
    local after_file="$2"
    local out="$3"
    python3 - "$before_file" "$after_file" "$out" <<'PY'
import re, sys
before, after, out = sys.argv[1:4]
def parse(path):
    counts = {}
    if not path:
        return counts
    try:
        text = open(path).read()
    except OSError:
        return counts
    for line in text.splitlines():
        m = re.match(r"\s*(\S+):\s*(\d+)", line)
        if m:
            counts[m.group(1)] = int(m.group(2))
    return counts
b, a = parse(before), parse(after)
delta = {k: a.get(k, 0) - b.get(k, 0) for k in set(b) | set(a)}
with open(out, "w") as f:
    for k in sorted(delta):
        if delta[k]:
            f.write(f"{k}: {delta[k]}\n")
PY
}
