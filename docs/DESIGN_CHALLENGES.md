# Design challenges

Read this before adding a control-plane API, a message store, or a
streaming path for chattic.us.

Challenges 1 and 2 are **decided**. Challenge 3 has a working model with
open sub-questions. Challenge 4 is **open**.

The reasoning is kept with each decision. A decision whose premise is not
written down cannot be re-checked when the premise changes, and every
premise here is one AWS price change or one product requirement away from
moving.

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
is the multi-tenant seam.** A per-request control plane goes from one
household to many at near-linear marginal cost, with no capacity
planning and no idle floor per tenant. v1 is one household but the
protocol is tenant-aware precisely so it can serve others without a
rewrite; the runtime should match.

Adopt this as a principle -- **nothing bills while nobody is working** --
or not at all. As a cost optimization it is marginal, and the cost
framing will lose the argument the first time the polling seam is
annoying.

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
- Do not name other vendors' agent products in Chatticus docs, bots, or
  protocol types.
- Computers, snapshots, and prefer-local routing are a different layer.
  They keep moving independently.
