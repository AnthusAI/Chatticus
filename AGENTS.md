# AGENTS.md


## Project management with Kanbus

Use Kanbus for task management.
Why: Kanbus task management is MANDATORY here; every task must live in Kanbus.
When: Create/update the Kanbus task before coding; close it only after the change lands.
How: See CONTRIBUTING_AGENT.md for the Kanbus workflow, hierarchy, status rules, priorities, command examples, and the mistakes to avoid. Never inspect project/ or issue JSON directly (including with cat or jq); use Kanbus commands only.
Performance: Prefer kbs (Rust) when available; kanbus (Python) is equivalent but slower.
Warning: Editing project/ directly violates The Way. Do not read or write anything in project/; work only through Kanbus.

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

- `docs/` — product, architecture, stack, roadmap, messaging, tasks,
  threat model. Read
  `docs/MESSAGING.md` before adding a cloud API, message store, or
  streaming path, and `docs/DESIGN_CHALLENGES.md` for the requirements,
  the non-requirements, why the design is shaped this way, and what is
  still open. `docs/FEASIBILITY_TESTS.md` holds the assumptions that are
  decided but unmeasured; run the test before building on the decision
  it gates. Spike code is throwaway and does not go in `python/src`.
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
  channels, and messages even while v1 has a single household tenant.
- A **channel** is the conversation object. There is no separate thread.
  A bot's model input is its own memory plus the channel's compacted
  view. Every bot on a channel reads it; only the addressed bot acts.

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

`develop` is the continuous-integration branch. Merge accepted, green work
there as soon as it is ready. Do not park completed work on long-lived
feature branches waiting for `main`.

`main` is the release branch. Semantic-release runs only from `main`.
Do not treat a merge to `develop` as a production release. The release
workflow is local to this repo and authenticates with `GITHUB_TOKEN`;
do not call the platform-ci reusable workflow, which requires an
`anthusbot_gh_token` this repository does not have.

Open pull requests against `develop`. Promote `develop` to `main` when
you intend a release, not as the daily integration path.

## Cloud environments

Chatticus has three named AWS environments for the thin-turn front door:
**development**, **staging**, and **production**. Acceptance tests always
pass `--environment` for one of those names.

| Git | Cloud environment | CDK stack |
| --- | --- | --- |
| `develop` | development | `ChatticusThinTurn` |
| `main` (release) | staging | `ChatticusThinTurnStaging` |
| explicit gated deploy | production | `ChatticusThinTurnProduction` |

Merging to `develop` is not a production release and is not a staging
release. Promoting to `main` updates staging after CI. Production is a
separate deploy of a staging-proven release. Shared stacks
`ChatticusSnapshots` and `ChatticusComputers` are not per-environment.
Never `cdk deploy --all`. Never destroy those two stacks.

## Pull request review

No human GitHub reviewer will show up. Review is done in this session with
**Composer 2.5** (and Bugbot when a branch diff should be checked) sub-agents.
Do not mark a PR ready and wait. Launch a reviewer against `develop`, treat
request-changes as blocking, and have a second agent apply fixes. Approval
from that loop is the merge gate, not a person on the PR.

## Milestones

At every milestone, launch a **sub-agent** whose only job is Kanbus and
the README. Comment on touched issues, keep statuses current, create
issues for significant new work, and update README "What is live today"
so it matches git and AWS. Do not fold that into the implementation
agent as an afterthought. The README states the same rule for humans.
