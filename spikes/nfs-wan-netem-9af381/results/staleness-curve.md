# Staleness curve (ea918a input)

Two NFS clients. client-a creates a marker file; client-b polls with **`stat`** (100ms loop).
One **`git status --porcelain`** trial per actimeo is contrast-only (confounded by ~30s git runtime).

| actimeo | ratio_overall (WAN) | stat staleness ms | git_status contrast ms |
| --- | --- | --- | --- |
| 1 | 1743.93x | 827 | 60873 (contrast) |
| 15 | 1629.53x | 747 | 57534 (contrast) |
| 300 | 1637.43x | 760 | 57303 (contrast) |
| 60 | 1640.27x | 768 | 56935 (contrast) |
| default | 1649.48x | 787 | 61439 (contrast) |
