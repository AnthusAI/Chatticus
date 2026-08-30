# Design challenges (open)

Read this before adding a control-plane HTTP API, a message database,
or a streaming path for chattic.us.

Several of these look decided in `docs/MESSAGING.md`, Gherkin, or the
in-memory kernel. They are **not**. That material is a sketch so we can
talk. Do not add CDK, Postgres schemas, or a WebSocket service as if
the answers below were picked.

The computer image already scales to zero when idle. The **cloud API**
is a different problem. It must be cheap when nobody is talking, and it
must still stream tokens while somebody is.

## 1. Cloud API: scale to zero and stream

**Need.** chattic.us (and later phones) call a cloud API. When a bot is
generating, the client must receive tokens as they appear. When nobody
is using Chatticus, we should not pay for an idle vCPU.

**Tension.** An open socket wants a process that stays up for the life
of a tab or a turn. Scale-to-zero wants that process gone. Those two
goals fight.

**What is already rejected (cost or lifetime, not capability).**

- AppSync (GraphQL realtime or Events) as the token pipe. It can hold
  WebSockets. It bills per update. A model turn is hundreds or thousands
  of tokens.
- Lambda as the holder of the socket. Lambda is for seconds-long work.
- API Gateway WebSocket plus Lambda. Same meter and lifetime problem.
- A queue per token (SNS/SQS). Turns are queued. Tokens are not.

**What is not rejected, and not chosen.**

- One small always-on control-plane process (REST + socket).
- Scale to zero between turns; wake on `POST` (Lambda or similar); hold
  a process only while a turn is streaming.
- SSE instead of WebSocket (read-only stream; approvals would need
  another path).
- Scale the **computer** to zero (already the Fargate default) while
  the API is a separate, smaller object.
- Local `docker-compose` as the API while developing, AWS later.

**Do not.** Implement a control-plane service in CDK until this is
picked with the humans who own the account. Placement, TLS, and how
chattic.us reaches the API are part of the same conversation.

A sketch of events and reconnect lives in `docs/MESSAGING.md`. Treat
it as a vocabulary (`turn.token`, `after=seq`), not as infra.

## 2. Storing messages

**Need.** A durable transcript the web app can reload. `tenant_id` on
every row. The computer snapshot is not the chat log.

**Not decided.**

- Postgres vs something else as source of truth.
- One table of append-only messages vs another shape.
- What is a **channel** vs a 1:1 thread vs a bot-only side conversation.
- Whether blobs (screenshots) live in S3 keyed off the transcript, or
  elsewhere.
- Schema, indexes, and who is allowed to write (only the control plane).

The in-memory `ControlPlane` methods (`create_thread`, `post_message`)
and `features/messages.feature` are a protocol doodle. They must not
drive a migration.

## 3. Compacting conversations

**Need.** Bots keep context. A channel that runs for months cannot be
stuffed into every model call. The human still wants to scroll history.

**Working model: non-destructive compaction on an immutable stream.**

This is the mechanism we will think with together. It is the same
shape as an append-only log with an appended snapshot (the Kanbus event
log never rewrites past events; a compact is another append).

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

**Still open.**

- Who writes the summary (a dedicated turn, the control plane, a
  nightly job).
- When to compact (token budget, message count, idle time).
- What a summary contains (prose, structured facts, both).
- How a summary is itself a participant in the next compact.

Do not implement a summarizer loop until the store exists. When it
does, compact by appending, never by mutating.

## 4. Direct bot-to-bot and channels

**Need.** Several named bots on one user. They must be able to talk
without the human being the router. The human should be able to watch
that work. Product language: a **channel** is a conversation with
the human and one or more bots (and later, bot-to-bot without a human
in the room). Do not import third-party product names for this.

**Not decided.**

- Is a channel the same object as a thread, or a room that contains
  threads.
- Does addressing a bot in a channel enqueue a turn (same as a human
  @-mention), or is there a separate A2A bus.
- Must every bot-to-bot line be visible in the channel the human has
  open, or are there private bot side-channels.
- How files move: path in `/workspace` (shared computer) vs attachment
  in the channel.
- Ordering when two bots run at once in one channel.

Bots must not HTTP-call each other. Workers pull jobs. That constraint
stands even while the channel model is open.

A sketch (one thread, `addressed_to_bot_id` enqueues a turn, human sees
the same rows) is in `docs/MESSAGING.md`. It is one candidate, not the
architecture.

## How to work on this

- Put behavior changes in Gherkin only when the humans have picked a
  path. Until then, discuss in this file and in chat.
- Compaction, if we compact at all, is non-destructive: append a
  summary, never rewrite the stream. See section 3.
- Do not treat `docs/MESSAGING.md` as locked. Update this file when a
  challenge is actually decided, then implement.
- Do not name other vendors' agent products in Chatticus docs, bots, or
  protocol types.
- Computers, snapshots, and prefer-local routing are a different layer.
  They can keep moving. Do not block them on the cloud API.
