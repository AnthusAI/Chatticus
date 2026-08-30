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
4. The worker runs the model loop on that machine and streams tokens,
   screenshots, and approval cards back over an outbound WebSocket.
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
inbound webhooks, and "wake a routine". It is **not** used for the agent
loop, computer use, or the display.

## Persistence

Compute and disk are separate. The **computer** is a `computer_id`. The
**host** is whichever Mac, Fargate task, or EC2 instance is running it.

Canonical workplace disk (`/workspace` and the browser profile) is an **S3
snapshot**. Hosts hydrate a local cache, run, and publish. Relocate is an
administrator action: point the next host at that snapshot. There is no live
container move. See [Computer snapshots](docs/COMPUTER_SNAPSHOTS.md).

| State | Where it lives |
| --- | --- |
| Conversations, bot memory, skills, routines | Postgres |
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
  docs/                     Product, architecture, stack, roadmap
```

v1 language for the product brain is **Python**. The web app is
**TypeScript**. Gherkin in `features/` is the behavior spec. Rust is not v1;
shared Gherkin keeps a later worker daemon possible.

## What you can run today

The only implemented product code is the in-memory control plane
(`python/src/chatticus/`). There is no HTTP API, no model loop, no
computer agent, and no web app yet. Postgres in `docker-compose.yml`
is not used by the kernel.

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

If Docker Desktop is running, you can also prove the computer image
builds and Postgres starts. Neither is wired to the kernel yet:

```bash
docker compose up -d postgres
docker build -t chatticus-computer computer/
```

## Documentation

- [Product](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Computer snapshots](docs/COMPUTER_SNAPSHOTS.md)
- [Stack](docs/STACK.md)
- [Roadmap](docs/ROADMAP.md)
- [AGENTS.md](AGENTS.md) for coding agents working in this repo
