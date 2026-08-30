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
            OpenAI API
            (Bedrock later)```

The control plane accepts messages, stores state, and enqueues turns. It
does not run the model loop and it does not own a display.

Workers register, heartbeat, pull matching jobs, call the model, execute
tools on their computer, and stream events back over an outbound WebSocket.

## Worker protocol

A worker advertises:

- `worker_id`
- `tenant_id`
- capabilities: `computer`, `browser`, `terminal`, `cpu`
- optional `computer_id` (the workplace this process hosts)
- cost class: `local`, `fargate`, or `ec2`
- heartbeat timestamp

A `worker_id` is owned by the tenant that first registered it. Re-registering
the same id under another tenant is rejected.

A turn job carries:

- `tenant_id`
- optional `user_id` and `bot_id`
- required capabilities
- optional `computer_id` pin (cookies and `/workspace` stay on one workplace)
- computer policy: `prefer_local`, `aws_only`, or `local_only`

Policy is stored on the **computer** and used as the default for that user's
turns. A turn may override it.

Routing:

1. Ignore workers whose heartbeat is stale, whose tenant does not match, or
   who lack required capabilities.
2. If the job is pinned to a `computer_id`, only hosts of **that** workplace
   may take it. Local and AWS workers for the same user share one
   `computer_id`, so a pin can fail over from a garage Mac to Fargate.
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
| Docker on a Mac | cheapest when the machine is on | local volume hydrated from the S3 snapshot |
| ECS Fargate (ARM64) | v1 AWS computer; burst, scale to 0 | task ephemeral disk hydrated from the S3 snapshot |
| EC2 stop/start | later; closest to an always-ready workplace | EBS as a warm cache of the same snapshot |

The image contains Xvfb (or equivalent) virtual displays, Chromium, a shell,
noVNC or equivalent for watch and takeover, `chatticus-worker`, and
`chatticus-agent`. v1 AWS computers run this image on **Fargate ARM64**
(same architecture as Apple Silicon Docker). Scale the Fargate service to
0 when no host is needed. Stop/start EC2 is a later host, not the v1
path.

Multiple virtual displays (`:1`, `:2`, …) are the bot screens.

## Computer snapshots

A host is not the computer. The garage Mac is a host in the same sense
Fargate is a host. Relocating a workplace is **publish to S3, then hydrate
on the next host**. It is not live migration and not `docker save` of the
OS image. The image stays in ECR. The snapshot is `/workspace` plus the
browser profile.

While `hydrate_required` is set, turns for that `computer_id` go only to
the intended host. Prefer-local ranking resumes after hydrate. Unpublished
writes block relocate so a Mac does not start from a stale checkpoint.

Failover when a prefer-local Mac's heartbeat dies is the same hydrate path on
an AWS host, from the last published snapshot. Work that was never
published is gone.

See [Computer snapshots](COMPUTER_SNAPSHOTS.md).

## What lives where

| Concern | Store |
| --- | --- |
| Bots, conversations, memory, skills, routines, approval rules | Postgres (RDS) |
| Turn jobs, heartbeats | SQS + scheduler records |
| Routine wake-ups | EventBridge |
| `/workspace` and browser profile | S3 snapshot (canonical); local volume, EBS, or EFS as a cache on the current host |
| Secrets | Secrets Manager |
| Object files / artifacts | S3 |

Stopping compute does not delete the published snapshot. That is how
Chatticus stays "always able to work" without paying for an always-running
vCPU. A host that is about to run the computer hydrates; it does not mount
the snapshot bucket as the container root.

## Agent loop

The model loop runs **on the worker**:

1. Load bot memory, conversation, skills, and the tool list (MCP + computer
   actions + tools from the model provider).
2. Call the configured LLM provider with function calling. v1 uses OpenAI.
   Amazon Bedrock is a later option. The agent talks to a provider interface,
   not a vendor-specific SDK from the rest of the loop.
3. Execute tool calls on the worker (or pause for approval).
4. Stream tokens, screenshots, and approval cards to the control plane.
5. Persist conversation and memory in Postgres via the control plane.

Provider-hosted tools (if the vendor offers them) may run on the provider.
Custom tools and computer actions always run on the worker.

## Approvals in the loop

Before executing a tool or computer action, the worker asks the control
plane to evaluate auto-review rules for that tenant (and user). Rules do
not leak across tenants. Consequential action types default to
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
