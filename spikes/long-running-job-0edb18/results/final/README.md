# Spike chatticus-0edb18 — consolidated evidence

Run date: 2026-09-05. Environment: development (`335163751677`, us-east-1).

Worker kernel: `chatticus.computer_host_worker.run_host_worker_once` (production pull
worker). Spike injects `NoopBootDriver` and `LongJobActionExecutor` only.

## Source runs

| Phase | Directory |
| --- | --- |
| Idle poll (obs 1) | `../20260905T183137Z-probes-f2dd4386/` |
| SQS visibility (obs 2) | `../20260905T183137Z-probes-f2dd4386/` |
| Heartbeat (obs 3) | `../20260905T183731Z-heartbeat-e049c923/` |
| 150 s iteration | `../20260905T183849Z-iteration-3c0ac7a7/` |
| 30 min authorized | `../20260905T184210Z-authorized-e8743925/` (in progress / see summary) |

## S3 prefix

`s3://chatticussnapshots-computersnapshotsb892d73f-r8qgykc9zjiq/spikes/0edb18/`

Objects deleted after each run.

## D8 verdict (draft)

**Corrected, not confirmed as stated.**

fbae4e D8: accelerated batch needs only SQS and scoped S3 credentials.

The spike shows SQS + S3 are necessary integration surfaces, but **insufficient** for
long work expressed as a turn:

1. `CHATTICUS_HOST_WORKER_SECONDS` (120) is an idle **poll** budget; active
   `execute()` is not capped by it, but other ceilings still apply.
2. Queue visibility defaults to 180 s; `ComputerWorker` never calls
   `queue_visibility_renewer`. Multi-day work exceeds SQS max visibility (12 h)
   regardless.
3. Heartbeat timeout is 30 s; `computer_host_worker` does not heartbeat during
   `execute()`. Routing rule 1 drops stale workers — no busy-vs-dead distinction.
4. Turn loop uses `turn_deadline` (120 s) and `attempt_lease` (60 s) without
   renewal on the computer pull path during long execute.

**Design conclusion:** accelerated batch needs a **manifold job kind** with its own
lifecycle (submit / poll / complete), not a longer timeout on the turn loop.
