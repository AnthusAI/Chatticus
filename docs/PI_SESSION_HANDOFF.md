# Pi session handoff

> **Status:** built and rehearsed on the development environment. For
> computers in Anthus's own AWS accounts, the container runs Pi for the turn
> and uses Pi's own tools. Staging and production do not run the TypeScript
> control plane or this path yet (see [Limits](#limits)).

This page explains how a bot's turn runs when it needs the computer: the
Lambda runs Pi until the first computer tool call, then the session is handed
to a Pi owner inside the computer container. It is written for a reader who has
not met Pi or pi-durable. The design came from a spike
([Pi harness, spike section](PI_HARNESS.md#spike-handoff-to-a-computer-owner));
this page records what was decided and how each decision was proven.

Two diagrams go with this page. Open each file in a browser; they are
standalone pages and need no server.

| Diagram | What it shows |
| --- | --- |
| [Built: Pi runs on the computer after a handoff](diagrams/pi-session-handoff/built-container-owner.html) | Who runs what, the model gateway, scoped credentials, the unprivileged shell, and the separate customer-account host worker |
| [Handoff, step by step](diagrams/pi-session-handoff/handoff.html) | One turn: park, start, takeover with the owner id, gateway call, snapshot publish, exit |

## Words used on this page

- **Pi** is the agent library Chatticus uses. It builds the model request,
  calls the model, runs the tools the model asks for, and loops until the model
  answers.
- **pi-durable** is the part of Pi that saves its work. Everything Pi does is
  written down before it is shown, so another process can pick the work up.
- **Session**: one bot's saved conversation in one channel. Its identity is
  `tenant#bot#channel`. It holds the transcript, the state of each task, and
  the messages waiting to be handled.
- **Owner**: the one process that is allowed to write a session. It is a
  TurnExecutor Lambda invocation, or the Pi owner in the computer container.
- **Fence**: a number that only goes up. Opening a session as owner takes the
  next number. Only the owner holding the current number can write.
- **Turn**: one run of the bot, from a person's message to the bot's answer.
- **Park**: stop a turn on purpose while something else finishes. The Lambda
  ends and the turn waits.
- **Computer**: the organization's shared Linux container with `/workspace`
  and a terminal. See [Architecture](ARCHITECTURE.md).
- **Owner task**: the Fargate task (`ChatticusComputerOwner`) that runs the
  container's Pi owner program, `owner.mjs`.
- **Host worker**: a small program in the computer image that claims actions
  over HTTP, runs them and posts the result. Only customer-account computers
  use it now.
- **Model gateway**: a route in the control plane between the container and the
  model provider, so the container never holds the real model key.

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
no new tool or model request. This was measured in the spike recorded in
[Pi harness](PI_HARNESS.md).

So ownership moves in one way: the old owner closes its session, and the new
owner opens the same storage with a higher fence. Nothing is copied. The new
owner reads the commits that are already there.

## How it works for own-account computers (built)

"Own-account" means a computer in Anthus's own AWS accounts. The diagrams are
[the architecture](diagrams/pi-session-handoff/built-container-owner.html) and
[the sequence](diagrams/pi-session-handoff/handoff.html).

1. A person sends a message. The browser calls CloudFront, which forwards
   `/api` to the FrontDoor Lambda. FrontDoor admits the turn and puts a job on
   the SQS queue `TurnRuns`.
2. The TurnExecutor Lambda takes the job, claims the turn, takes a fence and
   opens the bot's session (DynamoDB index plus the PiSessions S3 bucket). It
   runs Pi, reading the OpenAI key from SSM, until the model calls a computer
   tool (`read`, `write`, `edit` or `bash`).
3. That first computer tool call creates a ledger action, **parks** the turn and
   publishes a start job on the `ComputerStartJobs` queue.
4. The ComputerStarter Lambda generates an **owner id**, mints the gateway
   token bound to tenant, bot, turn and that owner id, assumes the scoped role
   with a per-session policy, and runs the owner task with that environment.
5. The owner program claims the parked turn under that owner id
   (`takeOverTurn`: the same Pi session, a new, higher fence). It hydrates
   `/workspace` from the computer's snapshot.
6. The owner replays the pending call locally using Pi's own tools, which are
   registered under our tool names, wrapped in the action ledger and safe to
   replay. Commands the model chose run through the `chatticus-shell` launcher
   as an unprivileged user (uid 2000) with a scrubbed environment, in the
   workspace group.
7. Model calls go to the gateway route
   `POST /orgs/:tenant/model-gateway/v1/responses`, with the token in place of
   a key. The gateway checks the token, checks that its owner id matches the
   turn's current attempt, adds the real key (which stays in the control
   plane), streams the answer back unbuffered and records the spend once.
8. The owner commits events as the same turn, publishes the workspace snapshot
   when content changed, finishes the turn and exits 0. The next message goes to
   a Lambda owner again, with a higher fence.

**One owner per computer.** The computer is one shared disk snapshot, so only
one owner runs at a time. A turn parked behind a live owner waits for it to
exit.

**Recovery.** The gateway compares the token's owner id with the turn's current
attempt, so when a turn is recovered by a new attempt the old container's token
stops working. A losing owner persists nothing. A tool call that was running
when an owner died is reported to the model as lost, not silently run again.

**Browse.** `browse` and `request_computer_capability` answer "browser not
available" at once on the owner path. Browse is not in the default grant and has
no executor there.

**Customer-account computers never get Pi.** A computer in a customer's AWS
account keeps the HTTP host protocol and the host worker permanently, because
that account must not write to the transcript store
([TypeScript control plane, section 4.2](TYPESCRIPT_CONTROL_PLANE.md#42-why-the-host-does-not-run-pi)).
This was an explicit design decision, so the system has two computer paths by
design.

## Decisions and how each was proven

| Decision | How it was proven |
| --- | --- |
| The container owner opens the same session with a higher fence and finishes the turn | Live smoke on development: echo command, answer in about 32 s, spend recorded through the gateway, clean exit |
| Pi's own `read`, `write`, `edit`, `bash` replace our copies and run locally | Live bug-fix task: 3 planted bugs, 12 of 12 tests passing, committed, and persisted to a fresh owner on a new channel |
| The container holds no model key; a per-turn token carries model calls | Live security run: the shell environment has no secrets, and the gateway records spend per call |
| The shell cannot reach the owner's credentials | Live security run: the shell cannot read the owner's environ, has no sudo or su, and writes only to `/workspace` and `/tmp`; the metadata endpoint returned no credentials, the credentials path variable is absent from the shell environment and the task role is empty |
| Storage credentials are scoped to one session | The STS session policy covers the conversation prefix and index keys, the computer's snapshot prefix and the organization's Messaging items. Two live failures were policy gaps (`ConditionCheckItem`, then the `MB#` mailbox key); both were fixed and covered by a scenario that records every request the owner makes |
| A dead owner is recovered and its token stops working | Live recovery: the owner task was stopped mid-command and a second owner took over about 125 s later; the lost tool was reported, not re-run |
| Own-account computers always start the owner | The runtime switch and the own-account host-worker start were removed |
| Customer accounts keep the host protocol | Design decision 3; the host worker code path is unchanged |

Behavior is covered by Gherkin, including `features/model_gateway.feature`,
`features/session_storage_policy.feature`,
`features/computer_owner_start.feature` and
`features/computer_owner_snapshot.feature`.

## Credentials and the model gateway

**How a call is redirected.** Pi's model library builds its OpenAI client from
the model's `baseUrl` and an `apiKey` passed with each call. The owner replaces
the base URL with the gateway and the key with the session token.

**The session token** is `ct1.<claims>.<signature>`, signed with HMAC-SHA-256
and expiring. It is bound to tenant, bot, turn and owner id. The signing key is
a secret in the control plane
(`conversation/src/gateway/session-token.ts`).

**The gateway** (`conversation/src/gateway/model-gateway.ts`) is mounted in the
FrontDoor app. Refusals are 401 (missing, malformed, forged or expired token)
or 403 (wrong organization, or the turn is not the running one for that owner).
A vendor failure is a 502 carrying only the vendor's status. The real key stays
in the control plane.

**What a stolen token can do.** It lets its holder make model calls for that one
turn and owner until it expires or the attempt changes. It is not the OpenAI
key, cannot be used for another tenant, bot or turn, and does not open storage.

**Scoped storage credentials.** `buildOwnerSessionPolicy` builds an IAM session
policy for one session: object access under `conversations/<storage>/`, item
access with `dynamodb:LeadingKeys` restricted to the session, the computer's
snapshot prefix, and the organization's Messaging items. The starter obtains
credentials from `sts:AssumeRole` on `ComputerOwnerScopedRole` with that policy.
The owner task definition has an empty task role, so the container holds
nothing beyond those credentials and the token.

## Computer sizes and moving between them

There is one computer image today. The session, not the container, is what
moves between owners. Other image kinds (a files-only image, a desktop a person
watches) are ideas and are not built. How a container is chosen is the subject
of [Computer manifold](COMPUTER_MANIFOLD.md), which is not implemented.

The files in `/workspace` move by snapshot: publish from one host, hydrate on the
next. A computer has one live disk at a time
([Computer snapshots](COMPUTER_SNAPSHOTS.md)), and unpublished work is lost if a
host dies.

## Limits

What is not built or not proven:

- **Environments.** Only development runs this. Staging and production do not
  run the TypeScript control plane or the computer path yet. Promotion is a
  separate project: it needs the migration runbook, per-environment Computers
  stacks and signing-key secrets, an image pipeline instead of the hand-pushed
  `:dev` tag, and a rehearsal in each environment.
- **Credentials endpoint.** The container credentials endpoint `169.254.170.2`
  cannot be blocked on Fargate (no `NET_ADMIN`). It is mitigated by the empty
  task role and the absent credentials path variable. It is not blocked.
- **Owner code is readable.** The shell can read the owner bundle code.
- **No refresh.** Scoped credentials and the gateway token last one hour, with
  no refresh for longer turns.
- **Gateway controls.** The gateway has no model allow-list and no per-call
  spend ceiling. It records spend at the end of the stream, so a client that
  disconnects early leaves that call unrecorded.
- **Policy headroom.** The session policy has about 30 characters of headroom
  under the 2048 character STS limit.
- **Lost tools.** A tool lost when an owner dies is reported, not re-run.
- **Browse.** `browse` is not in the default grant and has no executor on the
  owner path.
- **Leftovers.** The own-account Fargate host task definition and service in the
  Computers stack still exist and are removed in a later infra PR. Customer
  accounts still use the host worker.

## Build record

| Ticket | Pull requests |
| --- | --- |
| TS-65 owner core | #476 |
| TS-66 container entry point | #478 |
| TS-67 model gateway, token, session policy | #479 |
| TS-68 starter, infra, rehearsal fixes | #481, #482, #483, #484, #485 |
| TS-69 cutover | #486, #487 |

## Regenerating the diagrams

The sources are the two `.json` files in `docs/diagrams/pi-session-handoff/`.
The `.html` files are generated from them with the Archify skill. From the
repository root, with Archify installed at `ARCHIFY` (its `bin/archify.mjs`):

```bash
node "$ARCHIFY/bin/archify.mjs" finalize architecture \
  docs/diagrams/pi-session-handoff/built-container-owner.architecture.json \
  docs/diagrams/pi-session-handoff/built-container-owner.html \
  --quality showcase --json

node "$ARCHIFY/bin/archify.mjs" finalize sequence \
  docs/diagrams/pi-session-handoff/handoff.sequence.json \
  docs/diagrams/pi-session-handoff/handoff.html \
  --quality showcase --json
```

A non-zero exit means a gate failed. Fix the JSON and run it again. Delete the
`*.finalize*.json`, `*.browser-check.json` and `*.delivery.json` receipts the
command writes next to the output. The HTML files are about 0.75 MB each
because they embed the viewer.

## See also

- [Pi harness](PI_HARNESS.md): what pi-durable is, the storage, the fence.
- [TypeScript control plane](TYPESCRIPT_CONTROL_PLANE.md), section 3 (turn
  lifecycle on Pi) and section 4 (the computer).
- [Computer snapshots](COMPUTER_SNAPSHOTS.md): publish, hydrate and relocate.
- [Architecture](ARCHITECTURE.md) and [Computer manifold](COMPUTER_MANIFOLD.md).
