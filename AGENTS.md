# AGENTS.md

Instructions for AI coding agents working on Chatticus.

## What this project is

Chatticus is a named-teammate product: persistent bots, a user-scoped Linux
computer, approvals, skills, routines, and a pull-based worker protocol that
can run the computer on AWS or on local hardware.

The public site and product name is **Chatticus** at **chattic.us**.

Do not describe this product as a clone, port, or copy of any third-party
agent product. Do not use third-party product names for Chatticus bots, the
computer, skills, routines, or the worker protocol.

v1's LLM is **OpenAI**. Amazon Bedrock may follow. Do not assume or add an
xAI client. The model vendor is not the product name.

## Layout

- `docs/` — product, architecture, stack, roadmap, messaging. Read
  `docs/MESSAGING.md` before adding a cloud API, message store, or
  streaming path, and `docs/DESIGN_CHALLENGES.md` for the requirements,
  the non-requirements, why the design is shaped this way, and what is
  still open.
- `features/` — shared Gherkin. Behavior changes start here.
- `python/` — control plane, scheduler, roster, approvals, later agent and
  worker processes.
- `web/` — Next.js app for chattic.us.
- `computer/` — Docker image for the Linux workplace.
- `infra/` — AWS CDK.

## Working rules

- No emojis in code, docs, commit messages, or Gherkin.
- No backward-compatibility forks or "support both ways" branches. One
  correct path. Migrate data; do not keep dual readers.
- Long, clear names. No line-level comments. Sphinx docstrings on public
  Python. Rustdoc later if a Rust worker appears.
- Gherkin in `features/` is the product narrative. Implement Python steps in
  `features/steps/` so `behave` from `python/` passes.
- `tenant_id` is required in worker registration, jobs, bots, computers,
  threads, and messages even while v1 has a single household tenant.

## Quality gates

From `python/` after `pip install -e ".[dev]"`:

```bash
black --check src ../features tests
ruff check src ../features tests
behave
pytest
```

Do not declare worker-protocol work done if `behave` or `pytest` is failing.

## Computer and Lambda

Do not put computer use or the display on Lambda. The reason is that
Lambda cannot hold a browser, a display, or a session-lifetime
connection. Cite the reason, not the rule: a computerless worker running
the pre-computer part of a model loop does not touch that premise and is
allowed. It is a worker, not the control plane.

Lambda is allowed for HTTP, auth callbacks, inbound webhooks, scheduled
wake-ups, and holding one turn's server-sent event stream.

## The cloud API

There are no persistent sockets in Chatticus. Do not add a WebSocket,
browser-side or worker-side. Do not add AppSync. Do not put a load
balancer in front of the API; its hourly floor exceeds the always-on
container the design avoids.

A stream is scoped to **one turn**, never to a chat tab or a login
session. That distinction is what lets the control plane be per-request.
If a proposal needs a connection that outlives a turn, it is wrong for
this architecture.

The transcript is DynamoDB. Do not add a relational instance or write a
schema migration; an always-on database breaks scale-to-zero.

EventBridge and SQS are not in the token path. EventBridge is for
routine wake-ups, worker starts, and device push. SQS is for turn jobs.

`docs/DESIGN_CHALLENGES.md` lists the requirements these rules serve and,
just as importantly, the **non-requirements**. Check a proposal against
both before arguing for a change. Two that are misread most often:

- Chatticus does not need token-by-token delivery. It needs a human
  watching a turn to see it progress. Coalesced chunks satisfy that.
- Chatticus does not need throughput or scale. One household, a handful
  of concurrent turns. Serverless here is about the idle floor. Do not
  engineer for load that does not exist.
- Chatticus does need a bot to answer while its computer is still
  booting. Readiness is per-capability. Never put one "computer ready"
  barrier in front of the agent loop, and never hold the agent behind
  snapshot hydration.
- The computer is summoned, not assumed. A turn may run on a
  computerless worker and escalate when it first needs the computer. An
  agent may call `start_computer` early, and a caller may declare
  `computer` at enqueue, but correctness must never depend on either:
  touching a computer tool escalates on its own. There is no
  `stop_computer` -- the computer is shared by all of a user's bots.

See `docs/MESSAGING.md` for the design and `docs/DESIGN_CHALLENGES.md`
for the reasoning. Do not add a CDK control-plane stack until the
placement questions listed there are answered.

The computer is the Ubuntu image in `computer/`. The same image must remain
runnable on Fargate, EC2, and local Docker.

Durable computer disk is an S3 snapshot plus a local cache on the current
host. Do not mount S3 as the container root. Do not live-migrate containers.
Pack I/O lives in `python/src/chatticus/snapshot/`. See
`docs/COMPUTER_SNAPSHOTS.md`.

AWS resources exist only as CDK in `infra/`. Do not `aws s3 mb`, create
clusters, or click a bucket into existence. `cdk bootstrap` and
`cdk deploy` are the allowed AWS writes.

## Git

This repository is its own git repo. Do not commit Chatticus into the parent
`~/Projects` checkout.
