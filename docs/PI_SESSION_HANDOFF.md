# Pi session handoff

> **Status:** the Lambda-owner design is built and proven in development. The
> handoff design is a proposal under a spike; this document will be updated
> with the spike results.

This page explains how a bot's turn runs today, and one proposed change: let
the computer container run the agent for a while, then give the session back.
It is written for a reader who has not met Pi or pi-durable. Every statement
about today's system was checked against the code at commit `3b7f4ed7`. The
proposal is not built, and the spike (branch `ts/spike-pi-handoff`) has not
reported. Nothing below says how the spike turned out.

Three diagrams go with this page. Each one says in its title whether it shows
something built or something proposed.

| Diagram | Status | What it shows |
| --- | --- | --- |
| [Today: Pi runs in the Lambda](diagrams/pi-session-handoff/today-lambda-owner.html) | Built, proven live in development | Who runs what, and where the trust boundary is |
| [Proposed: Pi runs on the computer](diagrams/pi-session-handoff/proposed-container-owner.html) | Proposed, spike in progress | The model gateway, scoped credentials and the unprivileged shell |
| [Proposed handoff, step by step](diagrams/pi-session-handoff/proposed-handoff-sequence.html) | Proposed, spike in progress | One turn from message to the next message |

Open each file in a browser. They are standalone pages and need no server.

## Words used on this page

- **Pi** is the agent library Chatticus uses. It builds the model request,
  calls the model, runs the tools the model asks for, and loops until the model
  answers.
- **pi-durable** is the part of Pi that saves its work. Everything Pi does is
  written down before it is shown, so another process can pick the work up.
- **Session**: one bot's saved conversation in one channel. Its identity is
  `tenant#bot#channel`. It holds the transcript, the state of each task, and
  the messages waiting to be handled.
- **Owner**: the one process that is allowed to write a session. Today an owner
  is a TurnExecutor Lambda invocation.
- **Fence**: a number that only goes up. Opening a session as owner takes the
  next number. Only the owner holding the current number can write.
- **Turn**: one run of the bot, from a person's message to the bot's answer.
- **Park**: stop a turn on purpose while something else finishes. The Lambda
  ends. The turn waits and is queued again when the answer is ready.
- **Computer**: the organization's shared Linux container with `/workspace`, a
  terminal and a browser. See [Architecture](ARCHITECTURE.md).
- **Host worker**: a small program inside the computer container. It claims
  actions over HTTP, runs them and posts the result.
- **Model gateway**: a proposed service in the control plane. It would sit
  between the container and the model provider so the container never holds the
  real model key.

## What a Pi session is, and what pi-durable adds

Plain Pi keeps its state in memory. When the process ends, the state is gone.

pi-durable writes every step to storage first. The record types are
([Pi harness](PI_HARNESS.md) has the detail):

- **Entries**: the transcript. Some are what the model sees, some are tool
  results.
- **Tasks**: steps that save a checkpoint. One model turn is a task that owns
  one task per tool call.
- **Submissions**: input that was accepted, with an optional id so the same
  message is not handled twice.
- **Documents**: small pieces of state saved with the entries.

Chatticus keeps one session per bot and channel. The data lives in S3, one
file per commit. DynamoDB holds a small index that makes a commit visible. The
code is `conversation/src/storage/indexed-storage.ts`.

Because the session is stored, a process can stop and another can continue
from the last commit. That one property is what makes the rest of this page
possible.

## Who owns a session, and how ownership moves

A session has at most one writer. Two things enforce that.

1. **The turn claim.** The turn has a record in the Messaging table. A new
   owner has to win a conditional update on it first. It also holds a lease
   that it renews while it runs.
2. **The fence.** After winning the claim, the owner takes the next fence
   number for the session and opens the storage with it. Every commit checks
   that its fence is still the current one.

If a second owner takes a higher fence, the first owner is stale. Its next
commit fails with `OwnershipLost`, and after that it writes nothing and starts
no new tool or model request. Its own wait on the turn never finishes, so the
program that started it must close it. This was measured in the spike recorded
in [Pi harness](PI_HARNESS.md).

So ownership moves in one way: the old owner closes its session, and the new
owner opens the same storage with a higher fence. Nothing is copied. The new
owner reads the commits that are already there.

## How it works today (built)

This is the first diagram: [Today: Pi runs in the Lambda](diagrams/pi-session-handoff/today-lambda-owner.html).
It is built and proven live in development.

1. A person sends a message. The browser calls CloudFront, which forwards
   `/api` to the FrontDoor Lambda.
2. FrontDoor admits the turn and puts a job on the SQS queue `TurnRuns`.
3. The TurnExecutor Lambda takes the job. It claims the turn, takes a new
   fence, and opens the bot's session through pi-durable. The session lives in
   the Conversations DynamoDB table and the PiSessions S3 bucket. Only the
   fence holder can commit.
4. The Lambda runs Pi's agent loop. It reads the OpenAI key from an SSM
   SecureString at cold start and calls the model from the Lambda
   (`conversation/src/lambdas/openai-key.ts`).
5. Turn progress is written as events that FrontDoor streams to the browser.
6. When the model calls a computer tool (`read_workspace`,
   `write_workspace` or `run_terminal`), the tool does not run in the Lambda.
   It looks for a saved result for that call. If there is none, it hands the
   call to the executor, which records an **action** and **parks** the turn.
   The Lambda ends (`conversation/src/pi/computer-tools.ts`).
7. If no host is live, the executor queues a start job. The ComputerStarter
   Lambda starts an ECS Fargate task from the computer image
   (`computer/Dockerfile`).
8. The host worker in the container registers, restores `/workspace` from its
   snapshot, and then claims actions from FrontDoor over HTTP. For each action
   it asks FrontDoor to check it again against the turn's grant, runs it on
   `/workspace`, and posts the result (`computer/host/src/main.ts`).
9. FrontDoor sees the result and queues the turn again. A new Lambda owner takes
   a higher fence and opens the session. The parked tool runs again, finds the
   saved result by its call id, and Pi continues. The tool is marked safe to
   run again for exactly this reason.
10. When the host stops, it saves `/workspace` as a snapshot in S3. The next
    start restores it ([Computer snapshots](COMPUTER_SNAPSHOTS.md)).

**The trust boundary.** The computer runs commands the model chose. For that
reason the container holds no Pi, no model key and no database access. It
reaches the control plane only through the HTTP host routes. See
[TypeScript control plane, section 4.2](TYPESCRIPT_CONTROL_PLANE.md#42-why-the-host-does-not-run-pi).
An organization's computer can also live in a customer's AWS account, which
must not get write access to the transcript store.

## The limits of today's design

These follow from the code. I did not measure their cost.

- **Every computer tool call is a round trip.** The Lambda ends, a queue job
  starts a new Lambda, that Lambda opens the session again, and the host worker
  has to notice the action. A host with nothing to do looks for work once a
  second (`IDLE_SLEEP_MILLISECONDS` in `computer/host/src/main.ts`). A task
  with many small file or shell steps pays this each time.
- **Chatticus carries its own tool set for the computer.** Pi ships its own
  `read`, `write`, `edit` and `bash` tools (`pi-durable` 1.0.2, `dist/tools`).
  Today they are not used. Chatticus defines `read_workspace`,
  `write_workspace` and `run_terminal` and re-implements them in the host.
- **The Lambda has a time limit.** The TurnExecutor is set to 300 seconds, and
  a turn that nears it is handed on (`infra/lib/control-plane-stack.ts`,
  `conversation/src/turn/yield.ts`). A long job on the computer cannot be
  watched by one Lambda.
- **One kind of computer.** There is one image (Node, Xvfb, Chromium). There is
  no small image for files only and no image for a person to watch.
- **Commands run with the image's default user.** `computer/Dockerfile` has no
  `USER` line. The ECS task definition could change that, and I did not check
  it.

## The proposal: hand the session to the container

This is the second and third diagram:
[Proposed: Pi runs on the computer](diagrams/pi-session-handoff/proposed-container-owner.html)
and [Proposed handoff, step by step](diagrams/pi-session-handoff/proposed-handoff-sequence.html).
Both are **proposed, spike in progress, not built**.

The idea:

1. The Lambda owner closes the session. It queues a computer start.
2. The container starts. A Pi **owner process inside the container** opens the
   same storage with a new, higher fence.
3. That owner runs Pi with Pi's own tools (`read`, `write`, `edit`, `bash`)
   locally, next to `/workspace`. It commits events as the same turn.
4. When the turn is done, the container owner commits the answer and closes the
   session. The next message goes to a Lambda owner again, with a higher fence.

Why we think it is worth testing:

- Tool calls on `/workspace` need no round trip through queues and a new Lambda.
- Pi's own tools replace our copies of them.
- A session stored durably is not tied to one kind of container (see
  [Computer sizes](#computer-sizes-and-moving-between-them)).

Why it needs care: the container runs model-chosen commands, and the Pi owner
has to write the session. Those two facts pull in opposite directions. The next
section is about keeping them apart.

## Credentials and the model gateway

The container needs **no model key**. This is how that could work.

**How a call is redirected.** Pi's model library (`pi-ai` 1.0.2) builds its
OpenAI client from the model's `baseUrl` and an `apiKey` passed with each call.
It also accepts a custom `fetch`
(`dist/api/openai-responses.js`, `createClient`). It also has a second
protocol, `pi-messages`, that posts to `<baseUrl>/messages` with the key as a
bearer token (`dist/api/pi-messages.js`). So the container's Pi can be pointed
at a gateway URL, and the "key" it sends can be a token instead of the real key.

**What the gateway would do.**

1. Check the token. It is short-lived and bound to one tenant, one bot and one
   turn.
2. Read the real key from SSM, as the Lambda does today.
3. Forward the request to OpenAI and stream the answer back.
4. Record the spend in the existing vendor ledger
   (`conversation/src/ledger/vendor-ledger.ts`).

**What a stolen token can do.** It lets its holder make model calls for that
one session until it expires. It is not the OpenAI key, it cannot be used for
another tenant, bot or turn, and it does not open the database or the bucket.
The spend would be recorded against that turn. Whether the gateway also
enforces a spend ceiling per call is not decided.

**What the container still needs.**

- The token, for model calls.
- **Short-lived storage credentials scoped to the conversation's prefix**, so
  its Pi owner can commit to the one session it was given. In the storage
  layout the prefix is the S3 path `conversations/<storage>/` and the DynamoDB
  partition key `PI#<tenant>#<bot>#<channel>`
  ([Pi harness](PI_HARNESS.md)). IAM can restrict a role to such a prefix and
  key. Whether this layout works with those conditions has not been tested.
- Access to its own snapshot bucket, as today.
- A way to report turn progress. See the open questions.

**The shell must not reach any of this.** The Pi owner process holds the token
and the storage credentials. The commands the model chooses would run as an
unprivileged user that cannot read the owner's memory, files or environment and
cannot reach the container's cloud metadata endpoint. If it could, a model
command could take the credentials and the scoping would mean nothing. The spike
has to show that this separation holds. It is the most important unknown in the
proposal.

**Customer-account computers stay as they are.** A computer in a customer's AWS
account keeps the HTTP-only host protocol and never gets Pi, because that
account must not write to the transcript store
([section 4.2](TYPESCRIPT_CONTROL_PLANE.md#42-why-the-host-does-not-run-pi)).
That leaves two paths in the system. The working rules in `AGENTS.md` ask for
one path, so this needs an explicit decision.

### What exists now (TS-67)

Built and covered by `features/model_gateway.feature` and
`features/session_storage_policy.feature`; nothing is deployed.

- **The base-URL override works.** A pi-ai OpenAI Responses model with its
  `baseUrl` and per-call API key replaced (`createGatewayModels`) sends its
  request to the given address with `Authorization: Bearer <token>`, and parses
  the answer streamed back. This was run against a local fake endpoint and
  against the real gateway route.
- **Session token** (`conversation/src/gateway/session-token.ts`). Signed with
  HMAC-SHA-256 (`ct1.<claims>.<signature>`), expiring, bound to tenant, bot,
  turn and the attempt that owns the turn. Pure `mintSessionToken` and
  `verifySessionToken`; the signing key is an injected string of at least 32
  characters.
- **Gateway route** (`conversation/src/gateway/model-gateway.ts`):
  `POST /orgs/{tenant_id}/model-gateway/v1/responses`, audience `model-gateway`.
  It verifies the token, requires the path organization to equal the token's,
  requires the turn to be active for that bot and attempt, forwards the body to
  the vendor with the real key, streams the answer back chunk by chunk, and
  records the spend once from the final `response.completed` usage through
  `recordVendorSpend`. Refusals are 401 (no, malformed, forged or expired
  token) or 403 (wrong organization, or the turn is not the running one).
  A vendor failure is a 502 that carries only the vendor's status, never its
  text, because a vendor can echo part of a key. The vendor call is an injected
  `fetch`; the key is an injected string.
- **Mounting.** `composeFrontDoorApp` mounts the route only when
  `CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN` is set. It reads the key
  from that secret and the vendor key from `OPENAI_API_KEY` (already resolved
  from SSM), and logs one JSON line per refusal, vendor failure and recorded
  spend, without secrets.
- **Scoped storage policy** (`conversation/src/gateway/session-policy.ts`).
  `buildSessionPolicy` returns the IAM session policy as data for one
  `tenant#bot#channel` session: object get, put and delete under
  `conversations/<storage>/`, list of the bucket restricted to that prefix, and
  item actions on the conversation table and its indexes with
  `dynamodb:LeadingKeys` equal to `PI#<storage>`. Identifiers with wildcards,
  `$` or `#` are refused. Nothing calls STS.

What TS-68 must wire:

1. Expose the route. The front door is behind the invoke key header; the
   container reaches it through the same CloudFront path, so the origin header
   is added there. Confirm the CloudFront behavior forwards `/orgs/*` POSTs to the
   Lambda unbuffered; this was not checked here.
2. Create the signing-key secret, grant the front door Lambda read access, and
   set `CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN`. The Lambda's
   function-URL timeout and streaming mode must allow a full model answer.
3. At container start, the control plane (the component that claims the turn)
   mints the token with the attempt id it holds and a lifetime covering the
   turn, passes it with `CHATTICUS_MODEL_GATEWAY_URL`
   (`.../orgs/{tenant}/model-gateway/v1`) and `CHATTICUS_MODEL_GATEWAY_TOKEN`,
   calls `sts:AssumeRole` with `buildSessionPolicy` as the session policy, and
   hands the temporary credentials to the owner process only.
4. Decide a model allow-list and a per-call spend ceiling at the gateway; today
   any model name in the body is forwarded. A client that drops the connection
   before the final usage event leaves that call unrecorded.

## Computer sizes and moving between them

Today there is one computer image. The proposal makes the session the thing that
moves, not the container. Three kinds are imagined. None exists yet.

| Kind | For | Today |
| --- | --- | --- |
| Nano | Files and git. No browser. Starts fast and costs little. | Not built |
| Chromium | A browser for pages and scraping. | The one image has Chromium and Xvfb |
| Interactive desktop | A desktop that a person and the agent both see. | Not built |

How a container is chosen for the work is the subject of
[Computer manifold](COMPUTER_MANIFOLD.md), which is not implemented.

Two things move separately, and the proposal only changes the first:

- **The session** moves by closing it in one place and opening it in another.
  pi-durable stores it, so a new owner on a different kind of container can open
  it.
- **The files** in `/workspace` move by snapshot: publish from one host, hydrate
  on the next. A computer has one live disk at a time
  ([Computer snapshots](COMPUTER_SNAPSHOTS.md)). Changing container kind
  therefore means a publish and a hydrate, and unpublished work is lost if a host
  dies.

## Built, proposed, unknown

| Item | Built | Proposed | Unknown until the spike reports |
| --- | --- | --- | --- |
| Lambda owner opens the session and runs Pi | Yes, live in development | | |
| Computer tools park the turn; host runs them over HTTP | Yes, live in development | | |
| Model key read from SSM in the Lambda | Yes | | |
| `/workspace` saved to S3 on exit, restored on start | Yes | | |
| Container owner opens the same session with a new fence | | Yes | Whether it works end to end |
| Pi's own tools run locally on `/workspace` | | Yes | Behavior under the unprivileged user |
| Model gateway with per-turn tokens | | Yes | Where it runs, streaming limits, per-call spend ceiling |
| Scoped, short-lived storage credentials | | Yes | Whether IAM scoping fits the storage layout; how they reach the container |
| Unprivileged shell cannot reach credentials or metadata | | Yes | Whether it holds on Fargate |
| Hand the session back for the next message | | Yes | How the Lambda learns the container finished |
| Turn events reach the browser stream from the container | | | Route not chosen |
| Nano, Chromium and desktop container kinds | | Idea only | Everything |
| Customer-account computers | HTTP host protocol, no Pi | Stays | Two permanent paths against the one-path rule |

## Open questions

1. **What starts the handoff?** The start of a turn, or the first computer tool?
   Today a computer tool is the trigger for starting the computer.
2. **How do turn events get out?** Today the owner writes turn events to the
   Messaging table, with a check that it still holds the turn. The container has
   no database access in this proposal. A route through FrontDoor is possible and
   is not decided.
3. **How do the token and storage credentials reach the container?** At start,
   or fetched after it boots?
4. **What if the container dies mid-turn?** The probe and lease logic today
   assumes a Lambda owner. A container owner needs the same recovery.
5. **How does a Lambda owner learn the container is done?** And what if it never
   finishes?
6. **What does the gateway run on, and how does it stream?** The rules in
   `AGENTS.md` allow Lambda for HTTP and for one turn's stream, and rule out
   persistent sockets.
7. **Does the unprivileged shell hold?** In particular, can a model command read
   the owner's environment, its credentials or the task metadata endpoint?
8. **Two paths.** Managed computers with a container owner and customer-account
   computers with the host protocol. Is that acceptable?
9. **A desktop that a person watches** needs a live view. The cloud API rules
   forbid persistent sockets. How a view fits is not answered.
10. **Cost and latency.** Neither the round-trip cost today nor the saving from
    the proposal has been measured.

## Regenerating the diagrams

The diagram sources are the three `.json` files in
`docs/diagrams/pi-session-handoff/`. The `.html` files are generated from them
with the Archify skill. From the repository root, with Archify installed at
`ARCHIFY` (its `bin/archify.mjs`):

```bash
node "$ARCHIFY/bin/archify.mjs" finalize architecture \
  docs/diagrams/pi-session-handoff/today-lambda-owner.architecture.json \
  docs/diagrams/pi-session-handoff/today-lambda-owner.html \
  --repo-root . --quality showcase --json

node "$ARCHIFY/bin/archify.mjs" finalize architecture \
  docs/diagrams/pi-session-handoff/proposed-container-owner.architecture.json \
  docs/diagrams/pi-session-handoff/proposed-container-owner.html \
  --repo-root . --quality showcase --json

node "$ARCHIFY/bin/archify.mjs" finalize sequence \
  docs/diagrams/pi-session-handoff/proposed-handoff-sequence.sequence.json \
  docs/diagrams/pi-session-handoff/proposed-handoff-sequence.html \
  --repo-root . --quality showcase --json
```

A non-zero exit means a gate failed. Fix the JSON and run it again. The nodes of
the "today" diagram cite source files and line numbers at the commit pinned in
`meta.repository.revision`. When the code moves, re-read those lines, update the
revision and the line numbers, and regenerate. The HTML files are about 0.75 MB
each because they embed the viewer.

Edit the JSON when the spike reports. Change the status words in the titles and
subtitles at the same time as the content.

## See also

- [Pi harness](PI_HARNESS.md): what pi-durable is, the storage, the fence.
- [TypeScript control plane](TYPESCRIPT_CONTROL_PLANE.md), section 3 (turn
  lifecycle on Pi) and section 4 (the computer, why the host does not run Pi,
  the host protocol, the parked-tool handoff).
- [Computer snapshots](COMPUTER_SNAPSHOTS.md): publish, hydrate and relocate.
- [Architecture](ARCHITECTURE.md) and [Computer manifold](COMPUTER_MANIFOLD.md).
