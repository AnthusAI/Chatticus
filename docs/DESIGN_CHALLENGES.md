# Design challenges

Read this before adding a control-plane API, a message store, or a
streaming path for chattic.us.

It has four parts:

- **Requirements**: what must hold or the product is broken.
- **Non-requirements**: what looks like a requirement and is not. Read
  this one. Mistaking any of them for a requirement is how this design
  gets over-built.
- **Derived rules**: consequences of the two above, each naming the
  requirement it comes from.
- **Challenges**: 1 and 2 are **decided**, 3 has a working model with
  open sub-questions, and 4 is **open**.

The reasoning is kept with each decision. A decision whose premise is not
written down cannot be re-checked when the premise changes, and every
premise here is one AWS price change or one product requirement away from
moving.

## Requirements

These must hold or the product is broken. A proposal that violates one is
wrong no matter how cheap or elegant it is.

**Product**

1. A bot is persistent. Memory and context compound across turns. It is
   not a fresh session per task.
2. One computer per user, shared by every bot on that user. The **user**
   is the security boundary.
3. Work continues when the human's device is closed or offline.
4. Consequential actions are gated by approval. Passwords, codes, and
   identity checks are a takeover of the computer, never text in chat.
5. The human is not the router between bots.
6. The human can watch bot-to-bot work. The mechanism is open; the
   visibility is not.

**Platform**

7. **Nothing bills while nobody is working.** No component has an idle
   floor. This is the principle the cloud API is built to satisfy.
8. Output reaches the browser as it is produced. A human watching a turn
   sees it progress. See also requirement 16: this starts at the
   beginning of the turn, not once the computer is ready.
9. The transcript is durable, append-only, immutable, and reloadable
   from a cursor.
10. The stream is fully re-derivable from the store. Work never depends
    on anyone watching.
11. **The tenant seam survives without a rewrite.** Chatticus will serve
    other households. v1 being one household does not make this
    aspirational.
12. Workers pull. The control plane never reaches into a worker, and a
    home machine needs no inbound ports.
13. The model loop runs on the worker, never on the control plane.
14. One computer image runs on Fargate, EC2, and local Docker.
15. The web app talks only to the control plane, never to a worker.
16. **A bot begins responding immediately, even while its computer is
    still booting.** Getting the computer ready is concurrent with the
    turn, not a gate in front of it. A cold computer delays the bot's
    first *computer action*; it must not delay the bot's first *word*.

## Non-requirements

These look like requirements and are not. Each one, mistaken for a
requirement, would push the design toward something more complex and
more expensive than the product needs. When a proposal is justified by
one of these, that is the tell.

1. **Token-by-token delivery.** The requirement is that a human watching
   a turn sees it progress. Chunks of roughly 250 milliseconds satisfy
   that completely. This is what licenses coalescing, and coalescing is
   what makes the per-event cost of everything downstream negligible.
2. **Lowest total cost.** The requirement is zero at idle. A design with
   a lower average bill but an idle floor **loses** to one that costs
   slightly more per turn and nothing at rest.
3. **A bounded cold start for the computer.** Two different latencies
   hide under "cold start", and only one of them is slack:

   - **Time to the bot's first word.** Fast, always. This is
     requirement 16, not a non-requirement.
   - **Time to the bot's first computer action.** Unmeasured and
     unbounded for now. Image pull plus display and browser startup,
     paid only when nothing is warm.

   The second is acceptable *because* the first is fast: the wait
   happens behind visible work rather than in front of it. Revisit when
   there is a real image and a real turn to measure; do not spend
   engineering on shrinking it before then. See challenge 5.
4. **Throughput, or anything resembling web scale.** One household, a
   handful of concurrent turns. Serverless here is about the **idle
   floor**, not about scale. Do not engineer for load that does not
   exist. This is the most likely way to over-build from a correct
   decision.
5. **Bidirectional realtime.** Approvals are rare and human-paced. A
   POST serves them. Nothing needs a duplex channel.
6. **Live updates in a tab with no turn running.** Device push, and a
   cheap poll, cover "something finished while you were away."
7. **Durable in-flight chunks.** Chunks are disposable. Only the
   committed message is durable. Losing chunks costs a re-read, never
   work.
8. **Exactly-once chunk delivery.** Chunks are idempotent by turn and
   sequence, and re-readable.
9. **Ordering across channels.** Only order within a channel is
   guaranteed, and `seq` at commit already provides it.
10. **Edits and deletes.** Out of scope for v1.
11. **Bots as a security boundary.** They are not, and no design should
    imply they are. Separate screens are work surfaces, not isolation.
12. **Live migration of a running computer.** Publish a snapshot, then
    hydrate on the next host.
13. **Multi-region or high availability.** Not v1.
14. **Sub-second lifecycle events.** Routine wake-ups, worker starts,
    and device push tolerate seconds.

## Derived rules

These are consequences, not axioms. Each names the requirement it comes
from, so that if the premise moves the rule is re-derived rather than
cited out of habit.

| Rule | Follows from |
| --- | --- |
| No transport that meters per connection or per message | 7 |
| No persistent sockets, browser-side or worker-side | 7 |
| A stream is scoped to one turn, never to a tab or a login session | 7, 8 |
| No always-on datastore; no relational instance | 7 |
| No load balancer in front of the API (hourly floor) | 7 |
| The worker/browser rendezvous is a readable store with per-reader cursors | 10 |
| Output is coalesced into chunks, not sent per token | non-requirement 1 |

### Why "no sockets" is a cost rule, not a taste

The ban on persistent sockets is worth stating precisely, because the
imprecise version will be misapplied.

We have paid large AppSync bills. That is the direct evidence, and it is
better than any arithmetic in this document. But the lesson is not "open
connections are inherently expensive." A socket held by a process you
are already paying for continuously costs nothing extra per connection.

A socket is expensive in two specific ways, and both trace to
requirement 7:

- **A managed socket service meters it.** Per update, per operation, per
  connection-minute. That is the AppSync bill, and it scales with how
  much the product is used rather than with how much capacity it needs.
- **A self-held socket requires a process that outlives the request.**
  That process has an idle floor whether or not anyone is connected.

So the rule is derived, not independent. The practical consequence: if
someone later proposes a socket on a process we are already running
continuously for unrelated reasons, do not cite this rule at them. Go
back to requirement 7 and re-derive. The answer may legitimately differ.

## How to record a rejection

Every rejected option below says which kind of rejection it is:

- **Shape.** The service cannot do the job, or can only do it through an
  extra hop. Stable. Does not change when prices change.
- **Cost.** The service can do the job and the arithmetic says no. Valid
  only under stated assumptions. Write the assumption next to it.

The first version of this document mixed the two. Three rejections that
read as absolutes ("Lambda is for seconds-long work", "polling is too
wasteful for tokens", "AppSync bills per update") were arithmetic
conditioned on assumptions we then changed. Keep them separate so a
future reader can tell what is settled from what is merely priced.

Approximate prices appear below as orders of magnitude, current as of
2026. Re-verify any number that is carrying an argument before it becomes
a build decision.

## 1. Cloud API: scale to zero and stream

**Decided.** No persistent sockets anywhere. The whole control plane
bills per request and costs nothing when nobody is working.

### The shape

```
browser  --POST /channels/{id}/messages-->  front door (per-request)
                                              writes message, enqueues turn,
                                              returns turn_id

browser  --GET /turns/{id}/stream (SSE)-->  streaming function
                                              polls chunk buffer, writes frames

worker   --pull job (SQS)-->  runs model loop
         --POST chunks-->     front door  -->  chunk buffer (TTL)
```

| Piece | Choice | Idle cost |
| --- | --- | --- |
| HTTP front door | Per-request HTTP (API Gateway HTTP API, or a Lambda function URL behind CloudFront) | zero |
| Live token stream | Server-sent events held by a streaming function, scoped to one turn | zero |
| Rendezvous between worker and browser | DynamoDB items keyed by turn and sequence, with a TTL | near zero |
| Turn jobs | SQS | zero |
| Lifecycle events, routine wake-ups | EventBridge | zero |
| Transcript | DynamoDB (see challenge 2) | near zero |

**Never put a load balancer in front of this.** An Application Load
Balancer has an hourly floor of roughly 16 to 18 dollars a month, which
is more than the always-on container this design exists to avoid. The
front door must be a service that bills per request and has no hourly
charge. This is the single easiest way to accidentally build something
more expensive than the thing it replaced.

### Why this works: the stream is scoped to a turn, not a tab

This is the hinge, and it is what makes serverless viable at all.

A socket that lives as long as a chat tab needs a process that lives as
long as a chat tab. That fights scale-to-zero and cannot be reconciled.
A stream that lives as long as **one turn** is a seconds-to-minutes
request, which is exactly the shape a per-request runtime serves well.

Consequences we accept:

- A tab holding no active turn holds no connection. It learns about work
  finished by a routine through device push, or a cheap "anything after
  seq?" poll every 20 to 30 seconds. That was always the job of push;
  see the notify path in [Messaging](MESSAGING.md).
- A streaming function has a maximum duration (15 minutes on Lambda). A
  turn can exceed it. The client reconnects with `after=seq` and a fresh
  invocation resumes from the cursor.

That second point is load-bearing rather than a fallback: because the
stream **must** be resumable, the buffer behind it must be a readable
store with per-reader cursors. That requirement is what decides the
rendezvous below.

### Why server-sent events instead of a WebSocket

A WebSocket was previously chosen so approvals could travel back up the
same connection. Approvals are rare and human-initiated; an ordinary
`POST` serves them. Server-sent events are simpler through CloudFront,
avoid an upgrade-time authentication path, and reconnect natively with a
cursor, which is the `after=seq` replay we need anyway.

Dropping the WebSocket also removes the **worker's** outbound socket.
The worker POSTs coalesced chunks to the same front door. Two persistent
connections deleted, not one.

### Coalescing

The worker does not emit one event per token. It flushes a chunk roughly
every 250 milliseconds. This cuts event volume by more than an order of
magnitude, makes the per-event cost of every option below negligible,
and is invisible to a reader if the client renders each chunk smoothly
across the following interval.

Any per-event cost argument in this document assumes chunks, not tokens.

### The rendezvous: why DynamoDB and not a delivery service

With both ends ephemeral, the worker's chunks and the browser's stream
have no shared memory to meet in. An always-on process gets this for
free; that is the real thing serverless costs us here.

| | fan out to N viewers | replay after reconnect | ordering | delivers to a waiting reader | zero at idle |
| --- | --- | --- | --- | --- | --- |
| EventBridge | yes | no | no | **no** | yes |
| SQS | **no (consumes)** | **no** | FIFO only | yes (long poll) | yes |
| DynamoDB, polled | yes | yes | yes (sort key) | no (poll) | yes |

**EventBridge: rejected on shape.** It routes an event to a target, and
a function target means a **new invocation**. There is no receive API
and no way to deliver into the invocation already holding the stream.
It would have to land in a store anyway, so it is strictly an extra hop.
Delivery is also unordered, which garbles a token stream unless every
reader re-sorts by sequence, which requires the sequence, which requires
the store. Cost is not the objection: at chunk rates it is a fraction of
a cent per turn.

**SQS: rejected on shape.** A queue is a work queue, not a fan-out. It
destroys a message on consume, so two tabs, or a laptop and a phone,
would steal each other's chunks. Fixing that means a topic plus one
queue per viewer, with queue lifecycle per viewer. Worse, a consumed
queue cannot be re-read, and the 15-minute reconnect above requires
re-reading.

**Kinesis: rejected on cost.** A shard has an hourly floor, roughly 11
dollars a month for one shard. It breaks zero on its own.

**AppSync: rejected on cost, and now on shape.** The original arithmetic
was per token and does not survive coalescing; at chunk rates it would
be affordable. It is rejected now because it is a managed WebSocket, and
this design has no WebSockets in it.

The cost objection is not hypothetical: **we have paid large AppSync
bills.** That is real evidence and it outranks any arithmetic here. The
lesson it carries is narrow and worth keeping straight -- a metered
transport bills for how much the product is *used*, not for how much
capacity it *needs*, which is the same failure mode as an idle floor
seen from the other end. See "Why 'no sockets' is a cost rule" above.

DynamoDB loses exactly one column in that table, the waiting reader, and
pays for it with up to 250 milliseconds of jitter that the client
smooths over. The other two lose columns that cannot be bought back.

**Polling is the price of not holding a socket, and it is cheap.** The
earlier objection ("polling the message store is too slow and wasteful
for tokens") was about the **browser** polling. A function inside AWS
querying one partition by sort key every 250 milliseconds is a different
cost and latency profile entirely: fractions of a cent per turn.

### The invariant that keeps this safe

> The stream is ephemeral and fully re-derivable from the store. The
> work is durable and never depends on anyone watching.

A turn runs to completion whether or not a browser is attached. The
stream is a **view**, never a participant. Hold this and scale-to-zero
cannot cost correctness. Break it once, by letting the stream carry
state not recoverable through `after=seq`, and every reconnect becomes a
bug.

This invariant is also what preserves the product promise that closing
the laptop does not stop work.

### Why the spin-up cost is acceptable

The computer container already cold-starts: image pull plus Chromium
boot, tens of seconds. A function cold start of about a second is noise
against that. Under `prefer_local`, when the garage Mac is on the worker
is already warm and the only cold thing is the front door. We are not
adding latency to the critical path; the critical path was always the
computer.

The interface should say so honestly. "Starting your computer" is a
real state, not dead air.

### Why we chose this over one small always-on process

An always-on container plus a small managed database is roughly 25 to 30
dollars a month, and it is genuinely simpler: the rendezvous is a
variable in memory and there is no polling seam.

The saving alone does not justify the extra moving parts. **The reason
is the multi-tenant seam** (requirement 11), which is a real commitment
rather than a door left open. A per-request control plane goes from one
household to many at near-linear marginal cost, with no capacity
planning and no idle floor per tenant. An always-on process multiplies
that floor by the number of tenants, or forces tenants to share one
process and take on the isolation problem that avoids.

Adopt this as a principle -- **nothing bills while nobody is working** --
or not at all. As a cost optimization it is marginal, and the cost
framing will lose the argument the first time the polling seam is
annoying.

Note what this argument does **not** claim. It is not that the system
must handle high load; see non-requirement 4. One household running a
handful of concurrent turns is the actual v1 workload, and the design
should stay boring at that size.

### Still open

Placement details, which are configuration rather than architecture:

- Which per-request front door (API Gateway HTTP API against a function
  URL behind CloudFront).
- How chattic.us reaches it: same origin, `api.chattic.us`, or a
  CloudFront behavior. TLS and session handling on the stream request.
- How workers authenticate their chunk POSTs.
- Whether local `docker-compose` runs a single process standing in for
  the front door while developing.

## 2. Storing messages

**Decided: DynamoDB.** Not a relational database.

### Why this was not an independent decision

A relational instance is always on and has a monthly floor. Keeping one
would break "nothing bills while nobody is working" no matter how
serverless the compute is: the database, not the compute, is what
silently keeps the meter running.

So challenge 1 largely decided challenge 2. Recording that coupling
matters: if the scale-to-zero principle is ever abandoned, this choice
should be revisited rather than inherited.

### Why it is a good fit anyway, not just a forced one

The transcript is an append-only stream keyed by channel and a
monotonic sequence, read as "everything after seq". That is a partition
key, a sort key, and a range query. Compaction by appending a summary is
the same pattern again: one query backwards to the latest summary, one
forwards for the tail.

The parts that feel relational -- bots, approval rules, routines -- are
small, low-traffic, and single-household. Ad-hoc joins across them are
where a relational store would earn its keep, and for one household
there are not many.

### One store, two lifetimes

In-flight chunks and committed messages are the same technology,
differing only by TTL:

| Item | Lifetime | Written by |
| --- | --- | --- |
| Turn chunk | TTL, hours | Worker, through the front door |
| Committed message | Permanent | Control plane, at `turn.completed` |

Live tail and history replay become nearly the same query shape against
the same key structure. This rhymes with compaction in challenge 3: one
stream, two read recipes; here, one store, two lifetimes.

**Keep the two item types distinguishable** -- a separate item type, or
an adjacent table -- so "messages are immutable and permanent" stays a
clean invariant instead of one with an asterisk about the rows that
vanish.

### Still open

- The exact key structure, and whether chunks share a table with
  messages or sit beside them.
- Whether bots, approval rules, and routines share the table or get
  their own.
- Screenshot and attachment handling: S3 objects referenced from the
  transcript, never bytes through the API.
- `tenant_id` is required on every item. How it participates in the key
  is not settled.

## 3. Compacting conversations

**Working model stands: non-destructive compaction on an immutable
stream.** A compact is another append, never a rewrite.

1. Messages are an **immutable stream**. Once written, a message is not
   edited or deleted. The store only appends.
2. Compaction **appends a summary message** to that stream. The summary
   is a normal row (a kind such as `summary`). It records which prefix
   it covers (for example `covers_through_seq`).
3. The original messages **stay**. Nothing is rewritten. The UI can
   still show the full stream.
4. The **compacted history** for a model call is: the **latest summary**
   plus **every message after it** (seq greater than `covers_through_seq`).
   If there is no summary yet, the compacted history is the whole
   stream (or a bounded tail until the first compact).
5. Compaction can run **anytime, asynchronously**. It does not lock the
   channel. New messages that land while a compact job is running have
   a higher seq than the prefix being summarized, so they appear in the
   tail automatically. A later compact can cover a longer prefix,
   including earlier summaries, by appending a newer summary.

```
[m1][m2][m3][m4][S covers 1-4][m5][m6]
model view: S + m5 + m6
human scroll: m1 .. m6
```

That is **one stream, two read recipes**, not two stores. Do not add a
second compacted table that can drift from the log.

### Still open

- Who writes the summary (a dedicated turn, the control plane, a
  nightly job).
- When to compact (token budget, message count, idle time).
- What a summary contains (prose, structured facts, both).
- **How a summary participates in the next compact.** Because the model
  view is "latest summary plus tail", every new summary is built from a
  previous summary plus messages, so summaries compound, and they
  compound lossily. This is the question that decides whether the model
  holds up over months. Answer it before the store lands, not after.
- Whether summaries are visible in the human scroll or collapsed.

Compaction is non-destructive: append a summary, never rewrite the
stream. Do not implement a summarizer loop until the store exists.

## 4. Direct bot-to-bot and channels

**Open.**

**Need.** Several named bots on one user. They must be able to talk
without the human being the router. The human should be able to watch
that work. Product language: a **channel** is a conversation with
the human and one or more bots (and later, bot-to-bot without a human
in the room). Do not import third-party product names for this.

**Not decided.**

- Is a channel the same object as a thread, or a room that contains
  threads.
- Does addressing a bot in a channel enqueue a turn (same as a human
  mention), or is there a separate bot-to-bot bus.
- Must every bot-to-bot line be visible in the channel the human has
  open, or are there private bot side-channels.
- How files move: path in `/workspace` (shared computer) vs attachment
  in the channel.

**Settled by challenge 1, and no longer open here:**

- **Ordering when two bots run at once in one channel.** The control
  plane assigns `seq` at commit, so order within a channel is already
  total. What remains is a rendering question -- two live token streams
  interleaving in one open tab, which wants per-turn lanes in the web
  app. It does not constrain the store.

Bots must not HTTP-call each other. Workers pull jobs. That constraint
stands even while the channel model is open.

A sketch (one thread, `addressed_to_bot_id` enqueues a turn, human sees
the same rows) is in [Messaging](MESSAGING.md). It is one candidate, not
the architecture.

## 5. Summoning the computer

**Requirement 16 is decided. The approach below is the direction; the
mechanism is specified and some details are open.**

Two problems share one answer. A bot must start talking immediately
(requirement 16). And the computer, which is the expensive resource,
should run only when a turn genuinely needs it.

### The prize is duty cycle, not cold start

Chatticus prefers structured tools over the browser. So a large share of
turns never touch a computer at all: answering from memory, summarizing a
thread, drafting in the user's voice, a routine that reads an API through
a connector. Booting a browser container for those is waste, and unlike a
cold start, which is paid once, it recurs on every turn forever.

Rough shape, to re-verify before it carries a decision:

| Host for a 2-minute turn | Approximate cost |
| --- | --- |
| Computer container, including the image pull | ~$0.005 |
| Computerless worker doing 20 seconds of reasoning | ~$0.0002 |

The absolute saving is small for one household. Two things make it
matter anyway. It scales linearly with tenants (requirement 11). And
without it, **scale-to-zero is defeated by trivial turns**: if every
"thanks, that will do" spins up a browser container, the expensive thing
is never actually idle and requirement 7 buys nothing.

### A computerless worker is still a worker

The pre-computer phase does not run on the control plane. It runs on a
**worker that has capability `cpu` and not `computer`**. It registers,
heartbeats, pulls a job, runs the model loop, and posts chunks like any
other worker. Requirement 13 is untouched.

The protocol already carries this. A turn job declares required
capabilities; workers advertise capabilities and a cost class. A
computerless worker is a narrower capability set and another cost class,
not a new concept.

This also means the standing "no agent loop on Lambda" rule does not need
relaxing -- it needs its premise stated. The rule exists because Lambda
cannot hold a browser, a display, or computer use. A phase that does none
of those does not touch the premise. Re-derive rather than cite, exactly
as with the socket rule.

### Readiness is per-capability, not one flag

Whatever host a turn is on, a single "computer ready" barrier in front of
the agent is the mistake to avoid. The container has independent gates,
and a turn blocks only on the one it needs:

| Gate | Needed for | Ready after |
| --- | --- | --- |
| Process and network | Model calls, memory, MCP and connector tools | seconds |
| `/workspace` hydrated | File actions | snapshot hydrate |
| Browser profile hydrated, display and Chromium up | Browser actions | display and browser startup |
| Watch and takeover surface | A human watching or taking over | last |

`chatticus-agent` starts the model loop as soon as the first row is
satisfied. Hydration and browser startup run in parallel with the opening
model call.

### Three ways to summon the computer

The same mechanism, entered from three places:

| Path | Who decides | When boot starts |
| --- | --- | --- |
| Declared at enqueue | Human, routine, or a calling bot | Before the first model call. Fastest. |
| `start_computer` tool | The agent, having read the request | One model round-trip in, overlapping its own reasoning |
| Implicit escalation | Nobody. Fallback. | At the first computer action, serialized |

**Correctness must never depend on the model calling the tool.** Touching
any computer tool escalates on its own. An agent that never calls
`start_computer` is slower, never wrong. The tool is an optimization
layered over a mechanism that works without it.

**Declared at enqueue** reuses the existing field: the turn job names
`computer` in its required capabilities, which routes it to a
computer-capable host from the start. This is not a new parameter. It is
declaring at enqueue what would otherwise be discovered mid-turn. A
morning routine that always drives a website should declare it and skip
the discovery round-trip; a human who knows the work is on a website can
say so; a bot handing off work knows what it is handing off.

**The `start_computer` tool** is:

- **Non-blocking.** It returns `starting`, `ready`, or `unavailable` and
  the agent keeps working. Only an actual computer action waits.
- **Idempotent.** Safe to call speculatively, twice, or when a warm local
  Mac already serves the workplace. Then it is a no-op reporting `ready`.
- **Policy-bound.** Under `local_only` with the Mac off it returns
  `unavailable` rather than quietly starting Fargate. `computer_policy`
  already carries this; the tool does not get its own policy.
- **Visible.** The call appears in the stream, so "why did this turn cost
  money" has an answer a human can read.

**There is no `stop_computer`.** One computer per user is shared by every
bot on that user, so a bot stopping it could strand another bot
mid-task. Idle-down is a platform concern, not an agent decision.

### Escalation

When a turn on a computerless worker reaches a computer action:

1. The host appends the tool call to the turn's stream.
2. It enqueues a job for the same turn with `computer` in required
   capabilities and the user's `computer_id` pin.
3. It stops. It does not wait, and it transfers no state.
4. A computer-capable worker pulls that job, reads the stream, executes,
   appends the result, and continues the loop.

**The stream is the handoff.** An agent loop's state is its message list,
and Chatticus already commits that list as an immutable append-only
stream with tool calls and results as rows. So a turn is portable across
hosts up to its first computer action. After one, it is pinned: a live
page, a shell's working directory, and running processes are host-local.
That pin is the existing `computer_id` pin, not a new concept.

This is a payoff from challenge 1. Because the chunk buffer is a *store*
keyed by turn rather than a delivery path to a subscriber, two hosts can
append chunks to one turn and the browser's stream neither knows nor
cares.

The computer tools must still be **present** in the tool list on a
computerless worker, or the model never asks for one and never
escalates. Presence means "escalate", not "execute". The model does not
need to know the difference.

One loop, one package. The tool registry differs by host capability,
which the architecture already describes as a dynamic tool list. This is
not a second implementation and must not become one.

### Say what is happening

"Starting your computer" is a real state and belongs in the turn stream
as `turn.waiting`, naming the gate. A human who can see why a turn is
waiting will accept a wait that is otherwise indistinguishable from a
hang. See the event table in [Messaging](MESSAGING.md).

### What remains cold

Image pull, paid before any gate above. Do not attack it yet
(non-requirement 3). When it is worth attacking, the levers are a smaller
image, lazy image loading, or a warm host during active hours, in that
order.

Two things already blunt it. Under `prefer_local` a garage Mac that is on
is already warm, so the cold path is the exception. And the opening model
call is doing useful work while the pull runs.

### Still open

- Whether starting an AWS computer needs a spend control beyond
  `computer_policy`. It is not an approval-class action under the
  product's definition (nothing is sent, published, purchased, or
  deleted), but it does spend money on a bot's own initiative. Policy
  rather than an approval prompt is the likely answer; gating every boot
  behind a human would defeat the point.
- Whether a bot's recent behavior should speculatively declare `computer`
  at enqueue, and how that interacts with a wrong guess.
- Which cost class a computerless worker takes, and where it ranks. It is
  cheaper than every computer host, so ranking is not the hard part;
  naming is. See the note on `prefer_local` below.
- Whether `unavailable` under `local_only` should hold the turn until the
  Mac returns, or fail it back to the human.

### `prefer_local` is misnamed

The policy means "prefer already-warm and cheapest first". Locality is a
proxy for that, not the goal. A computerless worker is not local and
should rank ahead of every computer host; a warm pool on hardware that
exists anyway is not local either and should rank like it. The name
encodes an assumption that a third host breaks. Rename it before there is
a third host rather than after.

### Other substrates plug in here

The worker protocol is substrate-agnostic by construction: workers
advertise capabilities and a cost class, then pull. Nothing in the token
path, the store, or the scheduler cares what kind of machine answers.
Adding a warm pool -- Kubernetes, Nomad, a box that is on anyway -- means
adding a cost class and its rank, not changing the architecture.

The caution is requirement 7. A cluster bought **for** Chatticus is an
idle floor and is exactly what this design rejects. A cluster that exists
anyway for other reasons has no marginal cost here, so do not cite
requirement 7 at it; re-derive, and the answer legitimately differs. The
garage Mac already passes that test and is the warm-pool answer v1
actually ships.

## How to work on this

- Challenges 1 and 2 are decided. [Messaging](MESSAGING.md) now
  describes that design rather than sketching options. Build against it.
- Challenge 4 is open. Put channel behavior in Gherkin only when the
  humans have picked a path. Until then, discuss here and in chat.
- The messaging kernel in `python/src/chatticus/` and
  `features/messages.feature` predate these decisions. They encode a
  transport-agnostic protocol that survives, but they are not yet the
  DynamoDB and server-sent-events design. Do not treat them as either
  the schema or the transport.
- No persistent sockets. If a proposal needs one, it is wrong for this
  architecture; say so and find the turn-scoped version.
- Every new rejection states whether it is shape or cost, and a cost
  rejection states its assumption.
- Before arguing for a change, check it against Requirements and
  Non-requirements above. Most proposals that feel necessary are serving
  a non-requirement.
- Do not name other vendors' agent products in Chatticus docs, bots, or
  protocol types.
- Computers, snapshots, and prefer-local routing are a different layer.
  They keep moving independently.
