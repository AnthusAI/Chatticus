# Chatticus

Chatticus is a roster of named AI teammates that do real work on a computer
you control. You message a teammate. It uses tools, files, a browser, and a
shell. It comes back when something needs your approval.

The product lives at [chattic.us](https://chattic.us).

v1 is personal: one household, one AWS account, as many named bots as we
want. The worker protocol is tenant-aware from day one so the same system
can later serve other people without a rewrite.

## What Chatticus is

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
or an event). Teach-by-demonstration can turn a recorded browser path into a
draft skill.

**Approvals** stop consequential actions: sending, purchasing, publishing,
deleting, and production changes. Passwords, two-factor codes, and CAPTCHAs
are a human takeover of the computer, not text in chat.

Closing your laptop does not stop work. The computer runs on a worker, not
on the device in front of you. Optional local-device execution is a separate,
gated capability.

## Hybrid workers

The control plane never logs into the garage. Workers **pull**.

1. A worker registers with `worker_id`, `tenant_id`, capabilities
   (`computer`, `browser`, `terminal`, `cpu`), optional `computer_id`
   affinity, a cost class (`local` | `fargate` | `ec2`), and a heartbeat.
2. A user message or routine creates a **turn job** with required
   capabilities and an optional `computer_id` pin.
3. The scheduler prefers a healthy **local** worker, then an already-warm AWS
   computer, then a cold-start Fargate task.
4. The worker runs the model loop on that machine and POSTs coalesced
   output chunks, screenshots, and approval cards back to the
   control-plane front door. It holds no outbound socket.
5. If the garage Mac is off, AWS still runs the computer. If it is on, AWS
   compute spend drops to near zero.

Networking for a home machine: Tailscale or AWS Systems Manager hybrid
activation. No inbound ports. The watch/takeover display is tunneled
outbound through the control plane.

The same computer **image** runs on Fargate, stop/start EC2, or Docker on a
Mac. That is the cost lever.

## The computer is not Lambda

Lambda is the wrong runtime for a workplace: 15-minute cap, no persistent
display, no durable browser profile, no display takeover.

The Chatticus computer is a long-lived Linux container:

- virtual displays, Chromium, shell, `/workspace`
- `chatticus-agent` (model tool loop + computer use)
- `chatticus-worker` (heartbeat, pull jobs, stream events)
- a browser-based display for watch and human takeover

Lambda **is** used for short control-plane edges: HTTP, auth callbacks,
inbound webhooks, "wake a routine", and holding one turn's event stream.
It is **not** used for the agent loop, computer use, or the display.

## The cloud API scales to zero

There are no persistent sockets in Chatticus. The browser POSTs a
message and reads that turn's output as server-sent events; between
turns it holds nothing open. The worker POSTs coalesced chunks rather
than holding a socket of its own.

A stream scoped to **one turn** is request-shaped, so the whole control
plane can bill per request and cost nothing when nobody is working. The
computer already scales to zero; now the API does too.

A bot starts talking immediately, even from cold. Getting its computer
ready runs alongside the turn instead of in front of it: the agent begins
the model loop as soon as it has network and memory, and waits for a
display only if it actually needs one. A cold computer delays a bot's
first click, not its first word.

The computer is **summoned, not assumed**. Chatticus prefers structured
tools over the browser, so many turns never need a computer at all:
answering from memory, summarizing, drafting, reading an API through a
connector. Those turns run on a cheap computerless worker. A bot can
summon its computer when it decides it needs one, a routine or a person
can ask for it up front, and reaching for a computer tool summons it
anyway. That is what keeps the expensive container genuinely idle instead
of being woken by every trivial message.

The principle is: nothing bills while nobody is working. The reason is
not the monthly saving, which is small for one household. It is that a
per-request control plane serves many tenants at near-linear marginal
cost with no idle floor per tenant, which is where the tenant-aware
protocol is headed.

See [Messaging](docs/MESSAGING.md) for the design and
[Design challenges](docs/DESIGN_CHALLENGES.md) for the reasoning,
including what was rejected and why.

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

Computer policy: `prefer_local`, `aws_only`, or `local_only`.

Idle AWS computers stop (EC2) or scale to 0 (Fargate). The snapshot stays.

## Repository

```
Chattic.us/
  features/                 Shared Gherkin (product narrative)
  python/                   Control plane, agent, worker
  web/                      chattic.us web app
  computer/                 Linux computer image
  infra/                    AWS CDK
  docs/                     Product, architecture, design challenges, stack
```

v1 language for the product brain is **Python**. The web app is
**TypeScript**. Gherkin in `features/` is the behavior spec. Rust is not v1;
shared Gherkin keeps a later worker daemon possible.

## What you can run today

The only implemented product code is the in-memory control plane
(`python/src/chatticus/`) and the snapshot packer
(`python/src/chatticus/snapshot/`). There is no HTTP API, no model loop, no
computer agent, and no web app yet. Postgres in `docker-compose.yml`
is unused and predates the DynamoDB decision. Messaging helpers in the
kernel are a transport-agnostic sketch, not the DynamoDB and
server-sent-events design; see [Messaging](docs/MESSAGING.md).

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

## Task tracking

This repository uses [Kanbus](https://github.com/AnthusAI/Kanbus) for issue
tracking. The CLI is included in the Python dev dependencies (`pip install -e
".[dev]"` from `python/`). See [CONTRIBUTING_AGENT.md](CONTRIBUTING_AGENT.md)
for the workflow.

```bash
kanbus list
kanbus create "Describe the work" --type task
```

If Docker Desktop is running:

```bash
sh computer/test_relocate.sh
```

AWS resources are CDK only (`infra/`). Do not create them in the console.

```bash
cd infra
npm install
npx cdk bootstrap
npx cdk deploy --all
```


## Documentation

- [Product](docs/PRODUCT.md)
- [Tasks](docs/TASKS.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Design challenges](docs/DESIGN_CHALLENGES.md) (cloud API, messages, and channels decided; compaction sub-questions and API placement open)
- [Messages and the cloud API](docs/MESSAGING.md) (decided design, not a sketch)
- [Computer snapshots](docs/COMPUTER_SNAPSHOTS.md)
- [Stack](docs/STACK.md)
- [Roadmap](docs/ROADMAP.md)
- [AGENTS.md](AGENTS.md) for coding agents working in this repo
