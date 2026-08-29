# Architecture

Chatticus splits into a **control plane** that is always in AWS and a
**worker plane** of heterogeneous computers that pull jobs. v1 is one
household. Every record still carries `tenant_id`.

## Control plane versus workers

```
User at chattic.us
        |
        v
Control plane (AWS)
  auth, bots, conversations, approvals
  scheduler, SQS, EventBridge, Postgres
        |
        |  turn jobs (pull)
        v
+---------------+     +------------------+
| Garage Mac    |     | Fargate / EC2   |
| Docker worker |     | computer image  |
+---------------+     +------------------+
        |                     |
        +----------+----------+
                   |
                   v
            xAI Grok API
```

The control plane accepts messages, stores state, and enqueues turns. It
does not run the model loop and it does not own a display.

Workers register, heartbeat, pull matching jobs, call the model, execute
tools on their computer, and stream events back over an outbound WebSocket.

## Worker protocol

A worker advertises:

- `worker_id`
- `tenant_id`
- capabilities: `computer`, `browser`, `terminal`, `cpu`
- optional `computer_id` affinity (sticky workplace)
- cost class: `local`, `fargate`, or `ec2`
- heartbeat timestamp

A turn job carries:

- `tenant_id`
- required capabilities
- optional `computer_id` pin (cookies and `/workspace` stay on one workplace)
- computer policy: `prefer_local`, `aws_only`, or `local_only`

Routing:

1. Ignore workers whose heartbeat is stale, whose tenant does not match, or
   who lack required capabilities.
2. If the job is pinned to a `computer_id`, only that workplace may take it.
3. Under `prefer_local`, choose the healthy local worker if one exists, else a
   warm AWS computer, else request a Fargate start.
4. `aws_only` excludes local. `local_only` never starts AWS.

The control plane never SSHs into the garage. Workers pull from SQS. Home
machines need no inbound ports. Watch/takeover display traffic is an
outbound tunnel through the control plane (Tailscale or SSM hybrid
activation).

ECS Anywhere is optional later. A thin SQS-pull worker is the v1 local
plug-in.

The in-memory scheduler that encodes this protocol lives in
`python/src/chatticus/` and is specified by `features/*.feature`.

## The computer image

One Docker image, three hosts:

| Host | When | Disk |
| --- | --- | --- |
| Docker on a Mac | cheapest when the machine is on | bind-mount `/workspace`, local browser profile, optional S3 sync |
| ECS Fargate | burst, scale to 0 | EFS `/workspace`, S3 snapshot of the Chromium profile |
| EC2 stop/start | closest to an always-ready workplace | EBS keeps the profile across stops |

The image contains Xvfb (or equivalent) virtual displays, Chromium, a shell,
noVNC or equivalent for watch and takeover, `chatticus-worker`, and
`chatticus-agent`.

Multiple virtual displays (`:1`, `:2`, …) are the bot screens.

## What lives where

| Concern | Store |
| --- | --- |
| Bots, conversations, memory, skills, routines, approval rules | Postgres (RDS) |
| Turn jobs, heartbeats | SQS + scheduler records |
| Routine wake-ups | EventBridge |
| `/workspace` | EFS or local bind-mount; S3 for failover |
| Browser profile | EBS or S3 snapshot |
| Secrets | Secrets Manager |
| Object files / artifacts | S3 |

Stopping compute does not delete workplace disk. That is how Chatticus
stays "always able to work" without paying for an always-running vCPU.

## Agent loop

The model loop runs **on the worker**:

1. Load bot memory, conversation, skills, and the tool list (MCP + computer
   actions + built-in search/code tools from the model provider).
2. Call the xAI Grok API with function calling.
3. Execute tool calls on the worker (or pause for approval).
4. Stream tokens, screenshots, and approval cards to the control plane.
5. Persist conversation and memory in Postgres via the control plane.

Built-in provider tools (web search, code execution) may run on the
provider. Custom tools and computer actions always run on the worker.

## Approvals in the loop

Before executing a tool or computer action, the worker asks the control
plane to evaluate auto-review rules. Consequential action types default to
require-approval. The conversation shows the proposed operation. Allow-once
continues that action. Deny blocks it. Always-allow may save a matching
rule.

## Web

The web app at chattic.us is the human surface: bot roster, chat, approval
cards, and a computer preview. It talks only to the control plane. It does
not reach workers directly.

## v1 tenancy

v1 uses a single household tenant (for example `anthus`). The protocol still
requires `tenant_id` on workers, jobs, bots, and computers. A worker
registered to tenant A must never receive tenant B's jobs. That is the
multi-tenant seam.
