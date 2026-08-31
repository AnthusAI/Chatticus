# Chatticus

Chatticus is a roster of named AI teammates that do real work on a computer
you control. You message a teammate. It uses tools, files, a browser, and a
shell. It comes back when something needs your approval.

The product lives at [chattic.us](https://chattic.us).

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

GitHub **`main`** is **v0.5.0**. Three named thin-turn environments are
live in AWS account `335163751677` (`us-east-1`). Production is never
implied by a git branch; it is an explicit gated deploy of a release that
already passed staging acceptance. Staging and production were deployed
from `origin/main` @ `760915d`. Development was last redeployed ThinTurn-only
from `develop` @ `744dc8b` (no `--all`).

| Environment | Stack | CloudFront |
| --- | --- | --- |
| development | `ChatticusThinTurn` | https://d3gpuuldffe35o.cloudfront.net |
| staging | `ChatticusThinTurnStaging` | https://dntj3flm2ozck.cloudfront.net |
| production | `ChatticusThinTurnProduction` | https://d3lnmalpqx92ls.cloudfront.net |

`cd python && python scripts/exercise_thin_turn.py --environment <name>`
exits 0 for **development**, **staging**, and **production**. Each run
includes missing-turn claim **404** and a live second-worker claim **409**
while the lease is held, plus SSE `turn.started` / `turn.token` /
`turn.completed`. **Development** also proves `POST /turns/{id}/waiting`:
SSE `turn.waiting` naming `browser`, then a stale fence **409**. Staging
and production do not have that route yet.

The **source** has named cloud environments, turn **claim**, **lease**,
**fence**, durable channel lookup across Lambda invocations, a durable
logical-enqueue ledger, EventBridge Scheduler one-shot turn deadlines,
and a recovery kernel (`recovery_enabled` when the messaging table and
scheduler env vars are set). Kernel tests cover turn-boundary fault
injection and in-memory page-content authority containment (not wired
into the live worker HTTP loop).

What each deployed thin-turn slice does today:

- CloudFront in front of a Lambda function URL (no load balancer).
- FastAPI front door: channels, messages, bots, a stopped-computer roster,
  chunk POST, `POST /turns/{id}/claim`, `POST /turns/{id}/renew`, fenced
  chunk writes, `POST /turns/{id}/waiting` (development), and
  `GET /turns/{turn_id}/stream` as `text/event-stream`.
- Channel records and named bots are in DynamoDB, so a different Front Door
  instance can enqueue a turn for a bot it did not create.
- DynamoDB is the source of truth for the transcript, in-flight chunks
  (TTL), and the thin roster. SSE **polls the store**.
- SQS carries one turn job. A computerless worker Lambda runs
  **gpt-5.6-luna** (OpenAI). A text-only reply still completes. If the
  model calls `request_computer_capability`, the worker POSTs
  `turn.waiting` and leaves the turn active instead of claiming the
  browser work is done.
- Auth on this slice is an invoke key plus `X-Tenant-Id`, not product login.

Worker lease renew during long model calls is live on development.
EventBridge Scheduler one-shots are on each front door
(`chatticus-{environment}-turn-deadlines`); `recovery_enabled` is on.
Warm Front Door containers use a wall clock, so deadlines land in the
future. A wedged turn has recovered through EventBridge without a
forced Lambda cold start on development. GitHub **`main`** stays
**v0.5.0**; overnight, approval binding, unbound-browser, and
computer-handoff kernels on `develop` are not promoted there until they
are on the live worker loop.

**ChatticusSnapshots** and **ChatticusComputers** exist and must not be
destroyed. They are not on the turn path yet. The computer stays stopped.
There is no chattic.us web app, no local pull worker, no mid-turn
escalation, and no approvals on these slices.

Cloud-environment epic 9eef23 is closed: three named stacks, named-env
acceptance on each. Turn recovery epic 653989 is closed. Remaining for
summoning a computer (8f98f8): cold readiness measurement (e747d7) — not
a Fargate scale-up this cycle. Overnight gated-action (5b687a), immutable
approval binding (2b293d), unbound browser stops (813d8d), computer-seam
recovery (b41106), capability-gated readiness (`turn.waiting`, c0fbf0),
same-turn first computer tool (d3908f), and single shared computer start
(b6ab7d) are kernel-only; the unattended-gate decision is in
[Approval spec](docs/APPROVAL.md) (76d3e2). They are not on the live
worker loop.

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

v1 is the chattic.us Next.js app talking to that same per-request control
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
  Web["chattic.us<br/>Next.js"]

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
  python/                   Control plane, computerless worker, snapshot packer
  web/                      chattic.us web app (not on the live turn path yet)
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

The deployed thin turn is exercised against a **named cloud environment**
(CloudFront), not against an in-process queue:

```bash
cd python
python scripts/exercise_thin_turn.py --environment development
```

That resolves the front door from `CHATTICUS_DEVELOPMENT_BASE_URL`, SSM
`/chatticus/development/thin-turn/cloudfront-url`, or the
`CloudFrontUrl` output on stack `ChatticusThinTurn`. Pass `--base-url`
only when you already have the origin. Repeat with `--environment staging`
or `--environment production`. GitHub workflow **Acceptance**
(`workflow_dispatch`) runs the same script. It is not run on every
`develop` push; dispatch it after a deploy, with
`CHATTICUS_<ENVIRONMENT>_BASE_URL` set.

If Docker Desktop is running, the snapshot packer can be checked with
`sh computer/test_relocate.sh`.

AWS resources are CDK only (`infra/`). Do not create them in the console.
`cdk deploy --all` would touch **ChatticusSnapshots**,
**ChatticusComputers**, and every thin-turn environment; never do that.
Deploy one named stack:

```bash
cd infra
npx cdk deploy ChatticusThinTurn
npx cdk deploy ChatticusThinTurnStaging
npx cdk deploy ChatticusThinTurnProduction
```

**ChatticusThinTurn** is development. Staging and production are separate
stacks with their own DynamoDB, SQS, Lambda, and CloudFront; both are
deployed from the v0.5.0 release on `main`. Do not destroy the snapshot
or computer stacks.

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
- [Threat model](docs/THREAT_MODEL.md)
- [Tasks](docs/TASKS.md)
- [Feasibility tests](docs/FEASIBILITY_TESTS.md)
- [AGENTS.md](AGENTS.md) for coding agents working in this repo
