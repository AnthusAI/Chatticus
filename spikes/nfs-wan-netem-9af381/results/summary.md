# Phase A0 results summary

Warm-cache medians. `ratio_overall` = max(git_status, stat_sweep) when local checkout is below timer resolution.
pip_install excluded from verdict.

## Wall seconds (default actimeo, warm cache)

| condition | git_status | checkout | stat_sweep | pip_install |
| --- | --- | --- | --- | --- |
| local disk | 0.0196 | 0.0044 | 0.0226 | 0.7440 |
| NFS LAN (no netem) | 0.2513 | 0.5003 | 0.2567 | 0.1556 |
| NFS WAN (netem 20ms) | 32.3298 | 61.5819 | 33.4192 | 1.0615 |

Measured ping RTT: LAN 0.208 ms, WAN 24.69 ms (see `lab-info.json`).

## Headline

LAN NFS git_status 0.25s vs netem 32.33s — WAN netem adds ~32.1s. LAN alone vs local ~13x (marginal band). Stat-based cross-client staleness ~0.75–0.83s; actimeo did not materially separate it.
Local checkout median 0.0044s is below 0.01s timer resolution; `ratio_overall` uses max(git_status, stat_sweep) only.

Server: ganesha (see `lab-info.json`).

## Ratios vs local (netem, by actimeo)

| actimeo | git_status | stat_sweep | ratio_overall | verdict | stat staleness ms |
| --- | --- | --- | --- | --- | --- |
| 1 | 1743.93x | 1660.81x | 1743.93x | not viable (>10x) | 827 |
| 15 | 1629.53x | 1547.55x | 1629.53x | not viable (>10x) | 747 |
| 300 | 1637.43x | 1485.86x | 1637.43x | not viable (>10x) | 760 |
| 60 | 1640.27x | 1484.02x | 1640.27x | not viable (>10x) | 768 |
| default | 1649.48x | 1478.73x | 1649.48x | not viable (>10x) | 787 |
