# Observation 2 — SQS visibility

## Evidence

- `../20260905T183137Z-probes-f2dd4386/observation-2-sqs-visibility.json`
- `../20260905T183137Z-probes-f2dd4386/sqs-timeline-probe.json`
- Job run queue sampling: `../20260905T184210Z-authorized-e8743925/sqs-timeline-job.json`

## Finding

Development computer queue `VisibilityTimeout` is **180 s** (CDK +
`get-queue-attributes`).

Probe: message received, held **200 s** without `DeleteMessage` or
`ChangeMessageVisibility`. Approximate counts showed the message left the visible
pool (`not_visible=1`) while held; a concurrent Lambda consumer also competed for
the queue.

`ComputerWorker` accepts `queue_visibility_renewer` but **never invokes it** during
long `execute()`. `computer_host_worker.run_host_worker_once` does not wire a renewer.

AWS SQS maximum visibility is **12 hours**. Multi-day training cannot be one queue
message regardless of timeout tuning.
