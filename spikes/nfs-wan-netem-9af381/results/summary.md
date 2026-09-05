# Phase A0 results summary

Warm-cache NFS vs warm local-disk. `ratio_overall` = max(git_status, checkout, stat_sweep).
pip_install is on the NFS mount but **excluded** from verdict.

## Headline

At 20ms one-way netem (~40ms RTT), every actimeo value is **not viable (>10x)**.
Warm `git status` ~30s vs local ~0.01s (~3000x). `actimeo` did not materially change warm metadata latency in this lab.
Two-client staleness via `git status` on client-b stayed ~32s median across all actimeo values (cross-client attribute cache is not rescued by client-side actimeo alone).

Server: nfs-ganesha (kernel export failed in container). See `lab-info.json`.

| actimeo | git_status | checkout | stat_sweep | ratio_overall | verdict | median_staleness_ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 3136.0x | 61600.0x | 1779.0x | 61600.0x | not viable (>10x) | 33959 |
| 15 | 2988.0x | 57880.0x | 1652.0x | 57880.0x | not viable (>10x) | 32016 |
| 300 | 2982.0x | 57510.0x | 1570.0x | 57510.0x | not viable (>10x) | 32026 |
| 60 | 2990.0x | 57630.0x | 1586.0x | 57630.0x | not viable (>10x) | 31694 |
| default | 3003.0x | 57680.0x | 1582.5x | 57680.0x | not viable (>10x) | 32113 |
