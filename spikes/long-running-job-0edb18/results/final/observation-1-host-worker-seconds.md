# Observation 1 — CHATTICUS_HOST_WORKER_SECONDS

## Evidence

- `../20260905T183137Z-probes-f2dd4386/observation-1-idle-poll.json`
- Authorized job elapsed vs sleep: see `../20260905T184210Z-authorized-e8743925/job-metrics.json`

## Finding

`CHATTICUS_HOST_WORKER_SECONDS` (default **120**) governs the outer poll loop in
`computer_host_worker.main()`. With an empty queue the loop ran **135.7 s** across
106 iterations before giving up (`observation-1-idle-poll.json`).

During an active job, `run_host_worker_once` blocks inside
`ComputerWorker.run_job` → `action_executor.execute()` and is **not** interrupted
by the 120 s poll deadline. The 150 s iteration completed in **153.4 s** wall time.

Raising `CHATTICUS_HOST_WORKER_SECONDS` alone does not make long batch work a turn;
`turn_deadline` (120 s), `attempt_lease` (60 s), and SQS visibility (180 s) remain.
