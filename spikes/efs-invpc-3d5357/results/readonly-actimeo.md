# Read-only git status sweep (EFS vs EBS)

Repeated `git status` with **no mutation** between iterations. Remount between actimeo values.
Warm medians use iterations 2–20 only. RPC deltas from mountstats/nfsstat per iteration.
Cache warm when warm RPC median is **sharply below** first post-remount (not necessarily zero).

| actimeo | 1st wall (s) | warm wall (s) | warm/Ebs git | 1st RPC | warm RPC | RPC reduction % | cache warm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.2065 | 0.2748 | 29.55x | 367 | 480 | -30.8% | False |
| 15 | 0.1324 | 0.0928 | 9.98x | 203 | 131 | 35.5% | False |
| 300 | 0.1426 | 0.0945 | 10.16x | 203 | 131 | 35.5% | False |
| 60 | 0.1259 | 0.0906 | 9.74x | 203 | 131 | 35.5% | False |
| default | 0.1324 | 0.0928 | 9.98x | 203 | 131 | 35.5% | False |
