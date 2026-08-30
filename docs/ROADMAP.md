# Roadmap

## Immediate build order

The next milestone is running software, not another architecture pass.
Change a design document only when a feasibility test or implementation
exposes a decision that blocks the next slice.

1. Run feasibility test 1: prove that Lambda response streaming through
   CloudFront delivers coalesced chunks promptly enough for one-turn SSE.
2. Build the thinnest durable computerless turn: accept one authenticated
   message, commit its tenant, channel, bot, and turn identity to DynamoDB,
   enqueue it once, run one OpenAI text-only model loop, commit the answer,
   and stream it to the watching request. A reconnect reads committed state;
   no in-process stream is authoritative. Do not include a browser, Kanbus,
   approvals, snapshots, or mid-turn escalation in this slice.
3. Make queue delivery and worker failure safe before adding tools. Add a
   durable turn attempt, conditional lease, fencing token, idempotent enqueue
   and append operations, SQS visibility renewal, a deadline, and a
   scale-to-zero reaper. Test duplicate delivery and crashes on both sides of
   every DynamoDB, SQS, and model-call boundary.
4. Run feasibility test 2, then add the computer-at-enqueue path. Starting a
   computer requires a conditional lock per `computer_id`; a dead or wedged
   turn must release or expire its claim without an always-on scheduler.
5. Add mid-turn escalation only after the same ownership tests pass for a
   continuation. The computerless attempt must durably append the pending
   tool call and relinquish its fenced claim before a computer-capable attempt
   can continue it.
6. Admit browser authority only after the threat model has enforceable
   controls. Treat prompt/data separation as a mitigation, not a security
   boundary; enforce task-derived capability and egress limits outside the
   model. Generic authenticated browser actions that can send, publish,
   purchase, delete, or change production wait for a structured connector,
   human takeover, or another control that can describe and bind the exact
   operation.
7. Resolve the overnight-approval contradiction before specifying
   approval code. Requirement 3 says work continues with the laptop
   closed; requirement 4 says consequential actions are gated; v1 is a
   web tab and device push is "come back, something finished," not
   "approve this now." Either overnight work is scoped to
   non-consequential actions (the honest v1), or auto-review gets
   loosened and the threat model becomes theatre. Decide which, and write
   the decision into the approval spec rather than discovering it in
   production.
8. Complete the web app, approvals, task integration, snapshots, local-worker
   preference, and AWS computer path around those proven seams.

Throughout this sequence, the control plane and its data stores must retain a
zero idle billing floor. No step may introduce a persistent socket or an
always-on scheduler, lock service, API process, or database.

Deploy and accept against named cloud environments from the start:
**development** (`develop`), **staging** (`main`), then a gated
**production**. Do not treat a nameless stack as the product.

## v1 — personal, shippable scope

- Web chat at chattic.us
- Named bots with isolated memory
- One shared computer per user
- Model tool loop via OpenAI, with structured tools and the gated browser path
- Approvals for send / publish / purchase / delete / production changes
- `/workspace` on the computer
- Worker protocol with `tenant_id` and prefer-local routing
- Serverless control plane: per-request HTTP, one-turn server-sent events,
  DynamoDB transcript
- Task tracking through Kanbus, reachable without summoning a computer
- Computer snapshots: publish to S3, administrator relocate, host hydrate
- docker-compose for local control plane + computer
- Fargate (and optional EC2) path in AWS

This repository currently encodes worker routing, approvals, and
snapshot/relocate in Gherkin and an in-memory Python control plane.
Hosts can pack and hydrate a workplace through a filesystem object store
or the CDK S3 bucket (`ChatticusSnapshots`).

The in-memory messaging kernel predates the settled cloud design. Do not
extend it to reach the first milestone; replace or bypass it with the durable
turn path above.

The cloud API and the message store are now **decided**: a per-request
front door, server-sent events scoped to one turn, and DynamoDB. See
[Messaging](MESSAGING.md) for the design and
[Design challenges](DESIGN_CHALLENGES.md) for the reasoning. Channels
and bot-to-bot addressing are still open, as are parts of compaction.
The messaging kernel predates these decisions; it is a transport-agnostic
protocol sketch, not the schema.

Two assumptions underneath v1 are decided but unmeasured: that the
streaming path works, and how long a cold computer takes. See
[Feasibility tests](FEASIBILITY_TESTS.md). Run those before building on
them.

## v2

- Routines (EventBridge)
- Skills
- Human takeover of the computer display
- Connector/plugin install flow
- Amazon Bedrock as a second LLM provider (optional)

## v3

- Teach-by-demonstration
- Multi-tenant auth and billing. The *features* are v3; the *seam* is a
  v1 requirement. Serving other households is a commitment, not a door
  left open, and the architecture is held to it now.
- Desktop and iOS clients
- Optional Rust worker daemon
