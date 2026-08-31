# Status for returning agents (2026-08-31)

This page is the orientation snapshot. Kanbus issues are the record; this is the map. README "What is live today" is the public pin.

## What this product is

Persistent named household AI teammates, one shared Linux computer per user, approvals, pull workers. Cloud API: no persistent sockets, turn-scoped SSE + POST, DynamoDB, computerless turns that can later escalate. Idle floor is a requirement: nothing bills when nobody is working.

v1 LLM is OpenAI. Live model: **gpt-5.6-luna**. Key lives in `.env` (gitignored). CI uses the fake completion client.

## Branches and promotion

- `develop` is continuous integration. Merge accepted green work here. Open PRs against `develop`.
- `main` is the release branch. Semantic-release runs only from `main`. GitHub **`main` is v0.6.0** (`2249105`, PR #25).
- Git promotion does **not** redeploy CDK. Do not merge `develop` into `main` as daily parking.

| Git | Environment | Stack |
| --- | --- | --- |
| `develop` | development | `ChatticusThinTurn` |
| `main` | staging | `ChatticusThinTurnStaging` |
| explicit gated deploy | production | `ChatticusThinTurnProduction` |

Production is never implied by a git branch.

## Live AWS (account `335163751677`, `us-east-1`)

Development ThinTurn last successful redeploy: **`19070b1`** (ComputerWorker Lambda on `ComputerTurnJobs`, nack without host, no FakeComputerActionExecutor). `origin/develop` is ahead at **`a9c29b0`**: durable `host_start_generation` (**23c93e**), once-per-lease HostStarter (**60976f**), and SQS `batchItemFailures` nack (**29f269**) are in git, **not** on that pin until the next ThinTurn-only deploy.

Staging and production were last recorded from `origin/main` @ `760915d` (v0.5.0). Do not deploy them unless asked.

CloudFront development: https://d3gpuuldffe35o.cloudfront.net

`cd python && pip install -e ".[dev]" && python scripts/exercise_thin_turn.py --environment development` is the pass/fail gate. Unset `AWS_PROFILE` if it is `AdministratorAccess-335163751677`.

**ChatticusSnapshots** and **ChatticusComputers** exist and must not be destroyed. Computers service desired count stays **0**. Do not `cdk deploy --all`.

## On develop (not all of it is the live pin)

- Claim/fence, SSE `id` = seq, Last-Event-ID, household-recovery HTTP, waiting/resume, computer queue nack worker: live on development at `19070b1`.
- **23c93e** (open): persist `host_start_generation` + lease on Dynamo; worker records a start before nack; GET computer exposes generation. Blocked on `aws login` then `npx cdk deploy ChatticusThinTurn --require-approval never` from develop, then live exercise expecting `host_start_generation >= 1`.
- **60976f** (closed, kernel): ComputerWorker invokes an injected HostStarter once per host-start generation; retries share the lease. Default no-op. Not live until ThinTurn redeploy; do not enable ECS RunTask in CDK yet (sleep-infinity leak).
- **29f269** (closed, kernel): computer-queue Lambda returns `batchItemFailures` on `ComputerWorkerHostNotReady` so SQS leaves the job in flight. Not live until ThinTurn redeploy.
- Epic **8f98f8** (open): summon one computer. Remaining DoD is a Chromium-backed real executor via **ephemeral** Fargate `RunTask` (not standing `desiredCount=1`, not a fake `opened`). Chromium is in `computer/Dockerfile` but that image is not rebuilt/pushed/deployed.
- **e747d7** closed: Test 2 median ~22s to RUNNING; Chromium was not in the image at measurement time.
- Demo CLI epic **35d86b** is human-owned. Do not steal it. `exercise_thin_turn.py` stays the gate.

## In flight (do this next)

| Issue | Status | Note |
| --- | --- | --- |
| chatticus-23c93e | open | Redeploy development ThinTurn from develop; close only after live exercise |
| chatticus-8f98f8 | open | Ephemeral Fargate + Chromium executor after 23c93e is live |
| chatticus-35d86b | open | Human-owned demo CLI; leave it |
| chatticus-387e4f | open | Safari/background-tab; do not fake `document.hidden` |

## Do not

- `cdk deploy --all`
- Destroy `ChatticusSnapshots` or `ChatticusComputers`
- Deploy staging or production without an explicit ask
- Attach FakeComputerActionExecutor to live SQS
- Scale Computers to standing `desiredCount=1`
- Merge `develop` to `main` as parking
- Dual thread + channel APIs
- Put secrets in git
- Treat in-process queue fan-out behind SSE as the deployed architecture
- Edit `project/` issue JSON; use `kbs` only

## AWS

Account `335163751677`, region `us-east-1`. CDK only in `infra/`. ThinTurn-only for development: `cd infra && npx cdk deploy ChatticusThinTurn --require-approval never`.
