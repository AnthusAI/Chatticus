# Architecture

Chatticus splits into a **control plane** that is always in AWS and a
**worker plane** of heterogeneous computers that pull jobs. v1 is one
household. Every record still carries `tenant_id`.

## Control plane versus workers

```
    User at chattic.us
        |  POST to a per-request front door
        |  server-sent events for one turn
        v
Control plane (AWS, serverless)
  auth, bots, approvals, transcript
  scheduler, SQS, EventBridge, DynamoDB
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
            (Bedrock later)
```

The control plane accepts work, stores tenant state, and enqueues turns.
It does not run the model loop and it does not own a display.

The control plane is **serverless and holds no persistent sockets**. It
bills per request and costs nothing when nobody is working. The browser
POSTs messages and reads one turn's output as server-sent events. See
[Messaging](MESSAGING.md) for that design and
[Design challenges](DESIGN_CHALLENGES.md) for why.

Workers register, heartbeat, pull matching jobs, call the model, execute
tools on their computer, and POST coalesced output chunks back to the
same front door. A worker holds no outbound socket either.

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

The protocol is substrate-agnostic: a worker advertises capabilities and
a cost class, then pulls. Adding a host type -- a computerless worker, a
warm Kubernetes or Nomad pool, a machine that is on anyway -- means
adding a cost class and its rank, not changing the architecture. A pool
bought *for* Chatticus is an idle floor and is rejected; one that exists
anyway has no marginal cost here.

`prefer_local` is misnamed for what it wants, which is "prefer already
warm and cheapest first". Rename it before a third host type arrives.

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

**Startup ordering is a product requirement, not an implementation
detail.** The container brings up its capabilities independently and
`chatticus-agent` blocks only on the gate it needs:

| Gate | Needed for |
| --- | --- |
| Process and network | Model calls, memory, MCP and connector tools |
| `/workspace` hydrated | File actions |
| Browser profile hydrated, display and Chromium up | Browser actions |
| Watch and takeover surface | A human watching or taking over |

Do not add a single "computer ready" barrier in front of the agent.

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
| Bots, memory, skills, routines, approval rules | DynamoDB |
| Transcript (append-only messages, compaction summaries) | DynamoDB |
| In-flight turn chunks | DynamoDB items with a TTL, polled by the streaming function |
| Turn jobs, heartbeats | SQS + scheduler records |
| Routine wake-ups, worker starts, `turn.completed` to device push | EventBridge |
| `/workspace` and browser profile | S3 snapshot (canonical); local volume, EBS, or EFS as a cache on the current host |
| Secrets | Secrets Manager |
| Object files / artifacts | S3 |

Stopping compute does not delete the published snapshot. That is how
Chatticus stays "always able to work" without paying for an always-running
vCPU. A host that is about to run the computer hydrates; it does not mount
the snapshot bucket as the container root.

## Agent loop

The model loop runs **on the worker**.

It starts as soon as the worker has network and memory. It does **not**
wait for the display, Chromium, or a hydrated `/workspace`; those come up
in parallel and gate only the actions that need them. A turn that answers
from memory or works through MCP servers never waits for a browser.

A turn may begin on a **computerless worker** (capability `cpu`, not
`computer`) and escalate when it first needs the computer, by appending
the tool call to the stream and enqueueing a computer-capable job for the
same turn. No state moves: the stream is the handoff. An agent may summon
the computer early with a non-blocking, idempotent `start_computer` tool,
and a caller may declare `computer` in required capabilities at enqueue,
but correctness never depends on either -- touching a computer tool
escalates on its own. See challenge 5 in
[Design challenges](DESIGN_CHALLENGES.md).

1. Load bot memory, conversation, skills, and the tool list (MCP + computer
   actions + tools from the model provider).
2. Call the configured LLM provider with function calling. v1 uses OpenAI.
   Amazon Bedrock is a later option. The agent talks to a provider interface,
   not a vendor-specific SDK from the rest of the loop.
3. Execute tool calls on the worker (or pause for approval).
4. POST coalesced output chunks (roughly every 250 milliseconds, not one
   per token), screenshots, and approval cards to the control-plane front
   door. Screenshots go to S3 and are referenced, not sent as bytes
   through the API.
5. Persist bot memory and the committed message via the control plane.
   One message row is written at `turn.completed`, never one per token.

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
cards, and a computer preview. It talks only to the control plane. It
does not reach workers directly. It POSTs messages and reads one turn at
a time over server-sent events; it holds nothing open between turns. See
[Messaging](MESSAGING.md).

## v1 tenancy

v1 uses a single household tenant (for example `anthus`). The protocol still
requires `tenant_id` on workers, jobs, bots, and computers. A worker
registered to tenant A must never receive tenant B's jobs. That is the
multi-tenant seam.
