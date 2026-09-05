# Staleness curve (ea918a input)

Two NFS clients on the same export. client-a writes; client-b observes via `git status --porcelain` (lstat path).

| actimeo | ratio_overall | median_staleness_ms | performance vs freshness |
| --- | --- | --- | --- |
| 1 | 61600.0x | 33959 | actimeo did not separate perf vs staleness in this cross-client test |
| 15 | 57880.0x | 32016 | actimeo did not separate perf vs staleness in this cross-client test |
| 300 | 57510.0x | 32026 | actimeo did not separate perf vs staleness in this cross-client test |
| 60 | 57630.0x | 31694 | actimeo did not separate perf vs staleness in this cross-client test |
| default | 57680.0x | 32113 | actimeo did not separate perf vs staleness in this cross-client test |
