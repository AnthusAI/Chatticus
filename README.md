# Chatticus

Chatticus is a roster of named AI teammates that do real work on a computer
you control. You message a teammate. It uses tools, files, a browser, and a
shell. It comes back when something needs your approval.

The public marketing site is [chattic.us](https://chattic.us). The planned
production product workspace is [hey.chattic.us](https://hey.chattic.us)
(web CloudFront is disabled today; see What is live today).

v1 is personal: one household, one AWS account, as many named bots as we
want. Every record already carries a `tenant_id` so the same system can
later serve other people without a rewrite.

## Named teammates and one computer

A **bot** is a persistent, named teammate. It keeps memory, preferences, and
conversation. It is not a fresh chat session on every task.

A **computer** is a Linux workplace with a browser, a filesystem, and a
terminal. It belongs to a **user**, not to a bot. Every bot on that user
shares `/workspace`, browser sessions, and command-line credentials so they
can hand work off. Each bot gets its own screen so they can work in parallel.
Separate bots are not a security boundary.

Work prefers **structured tools** (APIs, MCP servers, connectors) when they
exist. The computer's browser is the fallback for sites and apps that have no
clean API.

A **skill** is how to do a task. A **routine** is when to run it (a schedule
or an event). **Approvals** stop consequential actions: sending, purchasing,
publishing, deleting, and production changes.

Closing your laptop does not stop work. The computer runs on a worker, not
on the device in front of you.

## How a turn works

A **turn** is one bot response: from a human message (or a routine) until
the control plane commits a single bot message to the transcript.

There are no persistent sockets. The browser **POSTs a message** and then
reads **server-sent events scoped to that one turn**. Reconnecting is a new
SSE request that reads already-committed chunks after `Last-Event-Id`.
In-process queues are not the architecture.

The **control plane** is the AWS side that accepts HTTP, stores tenant
state, and enqueues jobs. It does not run the model loop and it does not
own a display. It holds no always-on process in the token path, so when
nobody is working, nothing bills. That idle floor is the point: a quiet
household (and later, quiet tenants) should not pay for capacity that is
sitting empty. There is never a load balancer in front of the API; an
hourly LB charge would recreate the floor this design avoids.

**Pull workers** register, heartbeat, and take jobs from a queue. The
control plane never SSHs into a garage Mac. A worker that has CPU and
network but no display, browser, or `/workspace` is **computerless**.
Text-only turns can finish there. The computer is **summoned when a tool
needs it**, not assumed at enqueue: reaching for a display, browser, or
`/workspace` escalates the same turn onto a computer-capable worker. No
second transcript.

See [Architecture](docs/ARCHITECTURE.md) for routing,
[Messaging](docs/MESSAGING.md) for the transcript and stream, and
[Design challenges](docs/DESIGN_CHALLENGES.md) for rejected alternatives.

## What is live today

**2026-09-01:** Git **`develop`** is `4d139a9` (#151: Chatticus CDK stacks
set 30-day CloudWatch log retention; #150 closes the reconnect gate after
#149). `ChatticusDns`, all three `ChatticusWeb*` stacks, and matching
`ChatticusThinTurn*` stacks exist in `us-east-1`. Only **development**
`ChatticusWeb` has CloudFront **enabled** (`WEB_CLOUDFRONT_ENABLED` in
`infra/lib/environments.ts`; issue 7c1382). **Staging and production web
front doors are dark:** `ChatticusWebStaging` and `ChatticusWebProduction`
retain stacks but CloudFront is disabled, so `staging.chattic.us` and
`hey.chattic.us` are not serving HTTPS today. The marketing site remains at
`chattic.us` and `www.chattic.us`.

Same-origin HTTPS with `/api*` is **live on development** at
`https://dev.chattic.us/api`. SSM
`/chatticus/{environment}/thin-turn/cloudfront-url` records
`https://{hostname}/api` per environment; that path is reachable only where
web CloudFront is enabled.

**Live acceptance today is blocked** on a human SSM prerequisite: seed
`/chatticus/development/thin-turn/openai-api-key` before OpenAI turns run
(see `infra/README.md`). Until then the greeting stream hits `turn.failed`
after `turn.started`; `cd python && sh scripts/live_aws_thin_turn.sh
development` does **not** exit 0. Fence, claim, and computer checks may
still run when the deployed pin matches `develop`.

The last fully proven development gate was **2026-08-31** (ThinTurn-only
CDK pin after web-stack `/api*` fix): `health_environment=1`,
`missing_claim=404`, `claim_a=200` then `claim_b=409`,
`host_start_generation>=1`, computer continuation with `tool.result`.
That run used a deployed OpenAI key; it is historical, not today's status.

GitHub **Deploy ThinTurn (development)** and **Deploy Web (development)**
are manual (`workflow_dispatch`, see `infra/README.md`) and need the
`development` environment secret `AWS_DEPLOY_ROLE_ARN` from
`ChatticusGitHubDeploy`. Live workflow runs remain human-gated.
GitHub Actions must not hit live AWS.

**`develop`** is the continuous-integration branch; **`main`** is
release-only. Production is never implied by a git branch. Staging and
production thin-turn stacks may still reflect the v0.5.0 pin (`760915d`);
their web CloudFront has been disabled since 7c1382 and was not re-proven
on this pass.

Development **ChatticusThinTurn** last **ThinTurn-only** CDK pin is
**2026-08-31T21:56:57Z** (ECS host-start context after ECR `:dev` refresh).
**ChatticusWeb** restacks look up the live **ChatticusComputers** stack at
synth so a web restack cannot drop `ecs:RunTask`. **ChatticusComputers**
was not redeployed (`desiredCount` remains 0).

`dev.chattic.us` DNS may still fail; resolve the front door from SSM,
CloudFormation, or `CHATTICUS_DEVELOPMENT_BASE_URL`. Per-account CloudFront
distribution domains, Lambda function URLs, and AWS account ids belong in
gitignored `AGENTS.local.md`, not in this file.

A demo CLI (`python/scripts/chatticus_chat.py`) talks to that HTTP surface
so a person can watch tokens. `exercise_thin_turn.py` stays the pass/fail
gate.

| Environment | Web stack | Planned site | Web CF | API when CF enabled | Current posture |
| --- | --- | --- | --- | --- | --- |
| development | `ChatticusWeb` | dev.chattic.us | enabled | https://dev.chattic.us/api | Same-origin live; full exercise blocked on OpenAI SSM key |
| staging | `ChatticusWebStaging` | staging.chattic.us | **disabled** | would be https://staging.chattic.us/api | Stack exists; **dark** — resolve via SSM, CloudFormation, or `AGENTS.local.md` |
| production | `ChatticusWebProduction` | hey.chattic.us | **disabled** | would be https://hey.chattic.us/api | Stack exists; **dark** — do not treat hey as a live API front door |

Deploy DNS once (`infra/deploy-chatticus-dns.sh`), set registrar name servers
to the stack **NameServers** output, then deploy thin-turn + web per environment.
Until DNS propagates, pass `--base-url` with the CloudFront distribution domain
from stack outputs (record it in gitignored `AGENTS.local.md`, not in the repo).

If SSM or CloudFormation credentials are expired, set
`CHATTICUS_{ENVIRONMENT}_BASE_URL` or pass `--base-url`. SQS queue checks still need
`aws login`.

`cd python && sh scripts/live_aws_thin_turn.sh development` (same gate as
`python scripts/exercise_thin_turn.py --environment development`) is the
named-environment command. Full exit 0 requires the OpenAI SSM key above plus
a development deploy aligned with `develop`. When the gate passes, a
development run includes missing-turn claim **404** and a live second-worker
claim **409** while the lease is held (`claim_a=200` then `claim_b=409`,
because the fence probe starts the turn with `enqueue_turn=false` so the
computerless worker does not race the claim), plus **development** naming
itself on `GET /health` (`health_environment=1`), a live idempotent
channel post (`post_idempotent=1`: two `POST /channels/{id}/messages` with
the same `Idempotency-Key` produce one row), a duplicate bot create
(`bot_name_dup=1`: a second `POST /bots` with the same name returns
**400**), a live idempotent channel open (`channel_idempotent=1`: two
`POST /channels` with the same `Idempotency-Key` return one channel), a live
`GET /channels/{id}` roundtrip (`channel_get=1`), plus a live bot-memory
roundtrip (`POST /bots/{id}/memory` then `GET /bots/{id}`), a live
idempotent bot create (`bot_idempotent=1`: two `POST /bots` with the same
`Idempotency-Key` return one bot_id), a live named-bot lookup
(`bot_by_name=1`: `GET /bots?user_id=&name=` returns that bot_id), a live user bot list
(`bots_list=1`: `GET /users/{user_id}/bots` includes that bot_id), a live user channel list
(`channels_list=1`: `GET /users/{user_id}/channels` includes that channel_id), a live household computer read
(`computer_get=1`: `GET /users/{user_id}/computer` returns `computer_id`, `stopped=true`, and `host_start_generation`), a live channel active-turn read
(`channel_turn=1`: `GET /channels/{id}/turn` returns the fence-probe turn_id), a live user active-turn list
(`turns_list=1`: `GET /users/{user_id}/turns` includes that turn_id), a live waiting-turn read
(`channel_turn_waiting=1`: that path returns `waiting_for=browser` after the fence probe waits), a live empty active-turn read
(`channel_turn_done=1`: after the greeting completes, `GET /channels/{id}/turn` is **404**), plus SSE `turn.started` /
`turn.token` / `turn.completed`. **Development** also drops that greeting stream after
`turn.started` and a token, then reconnects through CloudFront with
`Last-Event-ID` and requires ordered replay through `turn.completed` (**only**
after a mid-token drop; terminal streams skip reconnect per #149).
After the greeting completes, **development** also lists channel history
with `GET /channels/{id}/messages?after=<seq>` and requires only later
rows, and lists the durable turn journal with
`GET /turns/{id}/events?after=<seq>` through `turn.completed`.
**Development** also proves `POST /turns/{id}/waiting`:
SSE `turn.waiting` naming `browser`, `GET /turns/{id}` returning
`waiting_for=browser` and pending tool `request_computer_capability`,
then a stale fence **409**, then
`POST /turns/{id}/resume` **409** while the household computer is stopped.
The fence probe also requires durable `turn.waiting` journal events to carry
`pending_computer_tool` with the same `action_id` as `GET /turns/{id}`. The same named exercise then asks luna to open the household browser; the
worker emits `turn.waiting` instead of completing, `GET /turns/{id}` still
names `browser` and the pending computer tool, the journal event matches that
`action_id`, and resume is **409** again. It then marks the computer
running, resumes that turn, checks `POST /turns/{id}/resume` returns
`required_capabilities=computer`, polls `GET /users/{id}/computer` until
`host_start_generation>=1`, and receives the continuation from
`ComputerTurnJobs` (not the cpu queue) as an in-flight nack, draining leftover
messages from interrupted runs, before marking the computer stopped. Staging
and production thin-turn pins may lag `develop`; their web CloudFront is
dark and was not re-proven on this pass.

The **source on `develop`** has org-scoped HTTP (`/orgs/{tenant_id}/...`),
organization records, a members CLI with suspend and reinstate, per-worker
bearer credentials, a dedicated `ChatticusBudgets` stack, and turn **claim**,
**lease**, **fence**, durable channel lookup across Lambda invocations, a
durable logical-enqueue ledger, EventBridge Scheduler one-shot turn
deadlines, and a recovery kernel (`recovery_enabled` when the messaging
table and scheduler env vars are set). Kernel tests cover turn-boundary fault
injection and in-memory page-content authority containment plus the
executable capability, egress, and browser-context policy kernel (not
wired into the live worker HTTP loop). Product login (Google/Cognito) is
decided in [Organizations](docs/ORGANIZATIONS.md) but not deployed.

What each deployed thin-turn slice does today (when restacked from
`develop`):

- CloudFront in front of a Lambda function URL on **development** web only
  (no load balancer). Staging and production web CloudFront is disabled.
- FastAPI front door under `/orgs/{tenant_id}/...`: `GET /health` (names
  the cloud environment on development), channels (`GET /channels/{id}`,
  `POST /channels`, `GET /users/{user_id}/channels`,
  `GET /users/{user_id}/turns`, and `GET /channels/{id}/turn`), messages,
  bots (`GET /bots?user_id=&name=` and `GET /users/{user_id}/bots`), the
  household computer (`GET /users/{user_id}/computer`), a stopped-computer
  roster, chunk POST, `POST /turns/{id}/claim`, `POST /turns/{id}/renew`,
  fenced chunk writes, `POST /turns/{id}/waiting` (development),
  `POST /turns/{id}/resume` (development; **409** while the computer is
  stopped; **200** with `required_capabilities` when running),
  `GET /turns/{id}` (development; exposes `waiting_for` and the pending
  `request_computer_capability` call), and `GET /turns/{turn_id}/stream`
  as `text/event-stream`.
- Channel records and named bots are in DynamoDB, so a different Front Door
  instance can enqueue a turn for a bot it did not create. Per-user bot
  names are reserved on the roster table so a recycled Lambda cannot fork
  two bots with the same name. A recycled Front Door can list a user's
  named bots and channels from that roster. A recycled Front Door can also
  read the household computer id and stopped flag. A recycled Front Door
  can read the active turn on a channel without a remembered turn_id, and
  list a user's in-flight turns the same way. A recycled Front Door can
  also read `GET /bots/{id}` (including memory), `GET /turns/{id}`,
  channel history with `after=`, and the turn journal with `after=`.
  Bot memory is
  stored on that roster item; a recycled Front Door hydrates the bot from
  Dynamo before writing memory. The computerless worker prompt is that
  memory plus the channel transcript. Another bot on the same computer
  does not inherit it.
- DynamoDB is the source of truth for the transcript, in-flight chunks
  (TTL), and the thin roster. SSE **polls the store**. Retrying
  `POST /channels` or `POST /channels/{id}/messages` or `POST /bots` with the same
  `Idempotency-Key` returns the original channel, message, turn, or bot after
  Front Door recycle.
- SQS carries one turn job. A computerless worker Lambda runs
  **gpt-5.6-luna** (OpenAI). A text-only reply still completes. If the
  model calls `request_computer_capability`, the worker POSTs
  `turn.waiting`, records `waiting_for` and the pending computer tool on
  the turn and in the durable journal event, and leaves the turn active instead of claiming the browser
  work is done. A later computerless delivery of that same turn does not
  claim it or call the model again. Resume while the computer is marked
  running records a computer-required continuation on a dedicated SQS
  queue the cpu worker does not consume, so the pending tool survives
  Front Door recycling. If such a job still reached a computerless
  worker, it is refused without ack. Resume of that
  same turn is refused while the computer is stopped. EventBridge deadline
  recovery does not fail a turn that is legitimately waiting on a gate.
- Auth: `X-Chatticus-Invoke-Key` is the CloudFront-to-Lambda gate;
  caller routes use the invoke key plus `/orgs/{tenant_id}/...` paths.
  Worker routes require `Authorization: Bearer` after
  `POST /orgs/{tenant_id}/workers/register`. No Google or Cognito login
  on these slices yet.

Worker lease renew during long model calls is live on development.
EventBridge Scheduler one-shots are on each front door
(`chatticus-{environment}-turn-deadlines`); `recovery_enabled` is on.
Warm Front Door containers use a wall clock, so deadlines land in the
future. A wedged turn has recovered through EventBridge without a
forced Lambda cold start on development. **`develop`** carries org-path
routing, worker bearer credentials, and reinstate; overnight, approval
binding, unbound-browser, and full computer-handoff execution still are
not on the live worker loop. Do not merge `develop` to `main` as daily
parking.

**ChatticusSnapshots**, **ChatticusComputers**, and (when deployed)
**ChatticusBudgets** exist and must not be destroyed. Chatticus CDK stacks
set **30-day** CloudWatch log retention (#151). Development ComputerWorker
may `ecs:RunTask` into that cluster with desired count still 0. Cold
Fargate time to `RUNNING` for the current computer image is tens of
seconds (Test 2). Chromium is in the image; the summoned Fargate host
runs `computer_host_worker` with `ChromiumActionExecutor` and publishes
per-capability readiness. Lambda ComputerWorker still has no browser
executor and only nacks until the host finishes. The product Next.js UI
deploys via `ChatticusWeb*` stacks (infra README); staging and production
web CloudFront is disabled. Approvals are not on these slices.

Cloud-environment epic 9eef23 is closed: three named stacks, named-env
acceptance on each. Turn recovery epic 653989 is closed. Cold Fargate
readiness (e747d7, Test 2) is measured for the current image: tens of
seconds to RUNNING; Chromium is in the image. Summoned Fargate host
readiness and Chromium execution (5dad85 / 8f98f8) are live on
development: RunTask overrides the container to `computer_host_worker`,
the host boots through the browser gate, and ComputerTurnJobs complete
with `tool.result` instead of perpetual `ComputerWorkerHostNotReady`
nacks.
Structured handoff (538d28) is
kernel-only on `develop` — model.request, tool.call, tool.result, and
attempt claim/relinquish are durable typed journal events; continuation
executes only unresolved action ids; failure injection covers handoff
boundaries and computer reclamation. Gherkin:
`structured_journal_handoff.feature` and
`computer_continuation_worker.feature`. Single-owner computer
start and readiness (53beb0) is kernel-only on `develop`: one
tenant/computer start claim, lease expiry and reclaim, per-capability
readiness recording, and stale-local prefer-local gating until snapshot
reconciliation. Gherkin: `single_computer_start.feature`,
`computer_host_readiness.feature`, plus `capability_gated_readiness.feature`.
Waiting-turn resume while the computer is stopped (66d3c4), waiting-turn gate read over HTTP (dfa7a9), pending
computer tool on the waiting turn (96c0e8), waiting journal snapshot
(d04942), computerless skip of a waiting turn (86c75d), computerless
refuse of a computer continuation (0b30dc), keeping computer
continuations off the cpu queue (f861ee), and a dedicated computer
turn queue with no worker attached yet (5c7e77), and a named-exercise
receive of that computer continuation from SQS (10ec55) are live on
development. Overnight gated-action
(5b687a), immutable approval binding (2b293d), unbound browser stops
(813d8d), computer-seam recovery (b41106), capability-gated readiness
(`turn.waiting`, c0fbf0), same-turn first computer tool (d3908f), and
single shared computer start (b6ab7d) are kernel-only; the
unattended-gate decision is in [Approval spec](docs/APPROVAL.md)
(76d3e2). They are not on the live worker loop.

```mermaid
flowchart LR
  Caller["Caller<br/>exercise script or HTTP"]
  CF["CloudFront"]
  FD["Front-door Lambda<br/>FastAPI, turn SSE"]
  DDB[("DynamoDB: messages, chunks, roster")]
  SQS["SQS turn jobs"]
  W["Computerless worker Lambda"]
  OA["OpenAI<br/>gpt-5.6-luna"]

  Caller --> CF --> FD
  FD --> DDB
  FD --> SQS
  SQS --> W
  W --> OA
  W -->|"POST turn chunks"| FD
  FD -->|"poll after cursor"| DDB
```

```mermaid
sequenceDiagram
  participant Caller
  participant CF as CloudFront
  participant FD as Front-door Lambda
  participant DDB as DynamoDB
  participant SQS as Turn queue
  participant W as Computerless worker
  participant OA as OpenAI

  Caller->>CF: POST /channels/channel_id/messages
  CF->>FD: origin
  FD->>DDB: commit human message
  FD->>SQS: enqueue turn
  FD-->>Caller: turn_id
  Caller->>CF: GET /turns/turn_id/stream
  SQS->>W: deliver job
  W->>OA: text-only completion
  W->>FD: POST coalesced chunks
  FD->>DDB: write chunk items with TTL
  loop poll store
    FD->>DDB: read after cursor
    FD-->>Caller: SSE frames
  end
  FD->>DDB: commit one bot message at turn.completed
```

## Where we are going

v1 is the product Next.js app at `hey.chattic.us` (production) talking to that same per-request control
plane, plus pull workers that can stay computerless or host the user's
Linux computer: local Docker when a Mac is on, Fargate ARM64 that scales
to zero when it is not. Workplace disk lives in S3 snapshots. EventBridge
will wake routines later. The model vendor is OpenAI; Amazon Bedrock may
follow.

Lambda is the right runtime for HTTP, auth callbacks, webhooks, routine
wake-ups, a computerless model loop, and holding **one turn's** SSE
stream. It is the wrong runtime for a workplace: it cannot hold a browser,
a display, or a session-lifetime connection. The computer is one Docker
image on Fargate, later stop/start EC2, or Docker on a Mac.

```mermaid
flowchart TB
  Person["Person"]
  Web["hey.chattic.us<br/>Next.js"]

  subgraph control [Control plane per request]
    FD["HTTP front door<br/>POST plus one-turn SSE"]
    Sched["Scheduler / routing"]
    DDB[("DynamoDB: bots, transcript, rules")]
    SQS["SQS turn jobs"]
    EB["EventBridge<br/>routines, worker starts, push"]
    SM["Secrets Manager"]
  end

  subgraph workers [Pull workers]
    CL["Computerless worker<br/>cpu, no display"]
    Local["Garage Mac<br/>Docker computer"]
    Far["Fargate ARM64 computer<br/>scale to 0"]
  end

  S3[("S3: snapshots, screenshots")]
  LLM["OpenAI<br/>Bedrock later"]

  Person --> Web --> FD
  FD --> DDB
  FD --> Sched
  Sched --> SQS
  EB --> SQS
  SQS --> CL
  SQS --> Local
  SQS --> Far
  CL --> LLM
  Local --> LLM
  Far --> LLM
  CL -->|"POST chunks"| FD
  Local -->|"POST chunks"| FD
  Far -->|"POST chunks"| FD
  Local --> S3
  Far --> S3
  FD --> SM
```

How a turn chooses a host:

1. A message or routine creates a turn job with `tenant_id`, required
   capabilities (`cpu`, and maybe `computer` / `browser` / `terminal`), and
   an optional `computer_id` pin.
2. Healthy workers pull. Prefer an already-warm cheap host (local Docker
   when the Mac is on), then a warm AWS computer, then a cold Fargate start.
3. The model loop runs **on the worker**, as soon as it has network and
   memory. Display, Chromium, and snapshot hydrate gate only the actions
   that need them.
4. Reaching for a computer tool escalates the same turn: the computerless
   attempt appends the pending tool call and a computer-capable worker
   continues. There is no `stop_computer`; the workplace is shared by all
   of a user's bots.
5. At `turn.completed` the control plane commits **one** message row.

## Persistence

Compute and disk are separate. The **computer** is a `computer_id`. The
**host** is whichever Mac, Fargate task, or EC2 instance is running it.

Canonical workplace disk (`/workspace` and the browser profile) is an **S3
snapshot**. Hosts hydrate a local cache, run, and publish. Relocate is an
administrator action: point the next host at that snapshot. There is no live
container move. See [Computer snapshots](docs/COMPUTER_SNAPSHOTS.md).

| State | Where it lives |
| --- | --- |
| Bot memory, skills, routines | DynamoDB |
| Transcript (append-only messages) | DynamoDB |
| In-flight turn chunks | DynamoDB, with a TTL; they expire after the turn commits |
| `/workspace` and browser profile | S3 snapshot; local volume / EBS / EFS as a host cache |
| Secrets | AWS Secrets Manager, never in the image |

Computer policy: `prefer_local`, `aws_only`, or `local_only`. Idle AWS
computers stop (EC2) or scale to 0 (Fargate). The snapshot stays.

## Repository

```
Chattic.us/
  features/                 Shared Gherkin (product narrative)
  python/                   Control plane, computerless and computer workers, snapshot packer
  web/                      Product workspace (`hey.chattic.us` in production)
  computer/                 Linux computer image
  infra/                    AWS CDK
  docs/                     Product, architecture, design challenges, stack
```

v1 language for the product brain is **Python**. The web app is
**TypeScript**. Gherkin in `features/` is the behavior spec.

## What you can run today

Local quality gates (CI uses a fake OpenAI client; a live key is not
required):

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
behave
pytest
black --check src ../features tests
ruff check src ../features tests
```

`black` and `ruff` versions are pinned in `python/pyproject.toml` so local
`pip install -e ".[dev]"` matches GitHub CI.

The deployed thin turn is exercised against a **named cloud environment**
(CloudFront on development only today), not against an in-process queue.
GitHub CI (`behave`, `pytest`) uses in-memory stores and moto. Live AWS is
a local command after `aws login`. Full exit 0 requires the OpenAI SSM key
documented in `infra/README.md`:

```bash
cd python
sh scripts/live_aws_thin_turn.sh development
```

That is the same as
`python scripts/exercise_thin_turn.py --environment development` plus an
identity check.

Watch one live conversation as a human (tokens on stdout, committed reply
at the end). Auth is invoke key plus `/orgs/{tenant_id}/...` paths for
caller routes; workers use bearer tokens after registration. No product
login yet:

```bash
cd python
export CHATTICUS_INVOKE_KEY=...   # or pass --invoke-key
python scripts/chatticus_chat.py --environment development \
  --tenant-id anthus --user-id ryan --bot Luna --message "hello"
```

The script resolves the front door like `exercise_thin_turn.py`
(`CHATTICUS_DEVELOPMENT_BASE_URL`, SSM, or CloudFormation). Omit
`--message` for an interactive prompt. `--list-turns` calls
`GET /users/{user_id}/turns`; `--watch-turn` reconnects with
`Last-Event-ID` on `GET /turns/{id}/stream`.

That resolves the front door from `CHATTICUS_DEVELOPMENT_BASE_URL`, SSM
`/chatticus/development/thin-turn/cloudfront-url`, or the
`CloudFrontUrl` output on stack `ChatticusWeb` (or `ChatticusThinTurn`
before the web stack exists). When AWS lookup fails, pass `--base-url` or
set the env var (see gitignored `AGENTS.local.md`). SQS queue checks
need that same AWS identity. Staging and production web CloudFront is
disabled; use thin-turn stack outputs or `AGENTS.local.md` when you mean
those environments. It does not scale Fargate. Do not run this from
GitHub Actions.

If Docker Desktop is running, the snapshot packer can be checked with
`sh computer/test_relocate.sh`.

AWS resources are CDK only (`infra/`). Do not create them in the console.
`cdk deploy --all` would touch **ChatticusSnapshots**,
**ChatticusComputers**, and every thin-turn environment; never do that.
Deploy one named stack:

Deploy development ThinTurn only:

```bash
cd infra
sh deploy-chatticus-thinturn-development.sh
```

That fails closed without AWS identity and never passes `--all`. Staging
and production, when you mean those stacks:

```bash
npx cdk deploy ChatticusThinTurnStaging
npx cdk deploy ChatticusThinTurnProduction
```

**ChatticusThinTurn** is development. Staging and production are separate
stacks with their own DynamoDB, SQS, Lambda, and CloudFront (web CF
disabled on staging and production). Do not merge `develop` to `main` as
parking. Do not destroy the snapshot, computer, or budgets stacks.

Postgres in `docker-compose.yml` is unused (it predates DynamoDB).

## Task tracking

This repository uses [Kanbus](https://github.com/AnthusAI/Kanbus). Prefer
`kbs` when it is on `PATH`. See [CONTRIBUTING_AGENT.md](CONTRIBUTING_AGENT.md).

```bash
kbs list
kbs create "Describe the work" --type task
```

At **every milestone** (a slice merged to `develop`, a promote to `main`, a
deploy, a closed epic, or anything that changes what is true), **launch a
sub-agent** whose only job is housekeeping. That agent comments on the
Kanbus issues it touches, sets statuses to match reality, **creates new
issues** for significant work that appeared, and **rewrites the "What is
live today" section of this README** (and the next-up line) so a new reader
is not looking at last week's world. Do not skip that pass. Do not treat it
as a leftover for the implementation agent.

## Documentation

- [Product](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Messages and the cloud API](docs/MESSAGING.md)
- [Design challenges](docs/DESIGN_CHALLENGES.md)
- [Computer snapshots](docs/COMPUTER_SNAPSHOTS.md)
- [Stack](docs/STACK.md)
- [Roadmap](docs/ROADMAP.md)
- [Approval spec](docs/APPROVAL.md)
- [Browser authority](docs/BROWSER_AUTHORITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Tasks](docs/TASKS.md)
- [Feasibility tests](docs/FEASIBILITY_TESTS.md)
- [AGENTS.md](AGENTS.md) for coding agents working in this repo
