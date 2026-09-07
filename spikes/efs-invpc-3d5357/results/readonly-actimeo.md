# Read-only git status sweep (EFS vs EBS)

Repeated `git status` with **no mutation** between iterations. Remount between actimeo values.
Warm medians use iterations 2–20 only. RPC deltas from mountstats/nfsstat per iteration.
Cache warm when warm RPC median is **sharply below** first post-remount (not necessarily zero).

| actimeo | 1st wall (s) | warm wall (s) | warm/Ebs git | 1st RPC | warm RPC | RPC reduction % | cache warm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.1343 | 0.1151 | 12.38x | 203 | 160.0 | 21.2% | False |
| 15 | 0.1343 | 0.0993 | 10.68x | 203 | 131.0 | 35.5% | False |
| 300 | 0.1343 | 0.0945 | 10.16x | 203 | 131.0 | 35.5% | False |
| 60 | 0.1343 | 0.0942 | 10.13x | 203 | 131.0 | 35.5% | False |
| default | 0.1343 | 0.0993 | 10.68x | 203 | 131.0 | 35.5% | False |
