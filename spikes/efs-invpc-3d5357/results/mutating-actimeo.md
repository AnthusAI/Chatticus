# Mutating A0 sequence (EFS vs EBS)

Separate from read-only timings. Warm-cache medians of full `run_ops` (status, checkout, stat, pip).
`ratio_overall` = max(git_status, stat_sweep) when EBS checkout below timer resolution.
pip_install excluded from verdict. Thresholds vs **local EBS** on same instance.

## EBS control

| git_status | checkout | stat_sweep | pip_install |
| 0.0093 | 0.0146 | 0.0594 | 0.9733 |

## EFS by actimeo

| actimeo | git_status | stat_sweep | ratio_overall | verdict |
| --- | --- | --- | --- | --- |
| 1 | 54.24x | 3.19x | 54.24x | D1 fails for /workspace (>10x) |
| 15 | 38.42x | 2.27x | 38.42x | D1 fails for /workspace (>10x) |
| 300 | 13.01x | 2.04x | 23.11x | D1 fails for /workspace (>10x) |
| 60 | 13.06x | 2.16x | 23.5x | D1 fails for /workspace (>10x) |
| default | 38.42x | 2.03x | 38.42x | D1 fails for /workspace (>10x) |
