# Observation 4 — Turn loop assumptions

## Evidence

- `job-metrics.json` (authorized 30 min run)
- `final-turn.json`
- `observation-job-authorized.json`

## Finding

Authorized run: **1800 s sleep + 2 GB S3 PUT** through `run_host_worker_once`.

| Event | UTC timestamp | Notes |
| --- | --- | --- |
| Sleep start | 2026-09-05T18:42:15 | Turn active, claimed by job id |
| Lease expired (sample) | 2026-09-05T18:43:15 | `attempt_lease` 60 s, no renew during execute |
| Turn deadline passed | 2026-09-05T18:44:15 | `turn_deadline` 120 s |
| Recovery re-enqueue | 2026-09-05T18:46:46 | `recovery_attempts=1`, claim dropped |
| Turn **failed** | 2026-09-05T18:47:16 | `terminal_reason: recovery attempts exhausted` |
| Sleep continues | until 19:12:15 | Worker blocked in execute(), unaware turn failed |
| 2 GB PUT completes | 2026-09-05T19:25:17 | S3 artifact landed |
| Final turn status | **failed** | `turn_completed`: **false** |

The worker process completed the spike action and deleted its injected SQS
receipt, but the **turn** did not complete. A multi-day training run cannot be
a turn: the turn loop declares failure while batch work continues orphaned.

In-flight chunk TTL defaults to 4 h (`DynamoMessagingStore.chunk_ttl_hours`); not
the binding constraint here — `turn_deadline` recovery exhausted first.
