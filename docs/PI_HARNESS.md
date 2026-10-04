# Pi harness

Design note for Kanbus story `chatticus-6c4d24` (epic `chatticus-9f09c5`).
Measured 2026-10-04 against `@earendil-works/pi-durable` 1.0.2 (Pi monorepo
`2003871`). The code is a throwaway spike in
[`spikes/pi-durable-6c4d24`](../spikes/pi-durable-6c4d24/README.md). No
product code depends on it.

## What we want

One durable engine for a bot's conversation that fits the serverless shape
in [Design challenges](DESIGN_CHALLENGES.md) and [Messaging](MESSAGING.md):
no always-on process, the transcript in DynamoDB, a stream scoped to one
turn, and a turn that can begin on a Lambda and continue on the computer.

The plan under test:

- One pi-durable storage per bot conversation (bot x channel), stored as one
  DynamoDB partition.
- Each turn is run by a short-lived **owner** (later a Lambda or the
  computer's worker). It claims the turn's fence, opens the storage, resumes
  unfinished tasks, submits the new message, runs, and closes.
- Only the fence holder can commit.

## What pi-durable is

A durable agent harness from the Pi framework. Everything is a committed
record before it is shown:

- **Entries**: the immutable transcript (`pi.user`, `pi.assistant`,
  `pi.tool-result`, `pi.system`, or our own kinds). Entries with a `model`
  field are what the model sees.
- **Tasks**: durable state machines that checkpoint each step. A turn is a
  `pi.generation` task (prepare, request, tools) that owns one `pi.tool`
  task per tool call.
- **Submissions**: admitted input with an optional `requestId` for
  deduplication. A submission to a busy conversation waits in the inbox as a
  steer or a follow-up.
- **Documents**: typed JSON state committed with entries, stored as a base
  plus Chord deltas (`pi.live` holds the streaming partial and tool output,
  `pi.inbox`, `pi.usage`, `pi.agent`, `pi.provider`).

It talks to storage only through a 16-method `Storage` interface:
`commit(writes)`, `mintId()`, and reads. The Session serializes commits and
assumes one process owns a storage at a time. It has no cross-process lock.
That is the part the fence supplies.

## The DynamoDB storage

One table, `pk`/`sk`, plus three local secondary indexes (`l1`, `l2`, `l3`).
Local indexes are used because they support strongly consistent reads, and
the storage contract requires read-after-write.

One storage is one partition, `pk = PI#<tenant>#<bot>#<channel>`.

| `sk` | Holds | Index keys |
|---|---|---|
| `META` | commit `seq` and the ID high-water mark | -- |
| `OWNER` | current `fence` | -- |
| `R#<id>` conversation | record JSON | `l1 C#<id>`, `l2 CT#<ownerTask>#<id>`, `l3 CC#<ownerConversation>#<id>` |
| `R#<id>` entry | record JSON, `s` = commit seq | `l1 E#<conversation>#<id>`; entries with a head also `l2 H#<conversation>#<id>` |
| `R#<id>` task | record JSON | `l1 T#<id>`, `l2 TS#<status>#<id>` |
| `R#<id>` submission | record JSON | `l1 S#<id>`, `l2 SS#<status>#<id>`, `l3 SR#<conversation>#<hash(requestId)>#<id>` |
| `R#<id>` document | lifecycle record, latest version | `l1 D#<hash(scope)>#<id>`, `l2 DA#<hash(address)>#<id>` |
| `V#<document>#<seq>` | one revision: a base or a Chord delta batch | -- |

IDs are zero-padded to 16 digits so key order is ID order.

- **Global ID namespace.** Every record is keyed `R#<id>`, so a collision is
  a key collision. Conversations, entries and documents are written with
  `attribute_not_exists(pk)`. Tasks and submissions replace themselves with
  `attribute_not_exists(pk) OR t = :type`.
- **Ancestry-aware entries.** Reads walk the fork chain (`parent.at` caps
  each ancestor) and query `l1` newest-first per conversation.
- **Point-in-time documents.** A read queries `V#<id>#` downward from the
  requested seq until it finds a base, then applies the deltas. For
  current-only documents the storage deletes revisions below a new base
  after the commit. If that fails, the old revisions stay as harmless
  garbage.
- **One commit is one `TransactWriteItems`.** It writes every record, a
  record plus a revision for each changed document, an update of `META`
  conditioned on `seq = <last seq this owner saw>`, and, when fenced, a
  `ConditionCheck` that `OWNER.fence = <my fence>`.
- **Reads before writing.** Document changes need the document's current
  record (retired? version?) and address occupancy. Measured average: 1.2
  to 2.1 read round trips per commit.
- **Size limits are checked before sending.** More than 100 items, more than
  4 MB, or an item over 400 KB becomes `StorageRejected`. pi-durable treats
  that as "nothing committed".

## Ownership and the fence

- `claimOwnership(fence)` raises `OWNER.fence` if the new value is higher.
- The storage then commits only with `fence = mine`. An owner that has lost
  the fence gets `StorageRejected: Owner fence moved` and cannot write.
- The `META` sequence condition is a second, fence-free guard: two handles
  can never interleave commits even when both claim the same fence.
- The Chatticus per-turn fence maps onto this directly. An attempt claims the
  turn (`attempt.claimed`) and that fence value is the storage fence.
  Relinquishing the attempt is closing the Harness.

## Results

All runs used moto 5.2.3 as the local DynamoDB. Amazon DynamoDB Local was
requested, but its image did not finish pulling in this session. The
conformance suite should be rerun against it before any product work.

| Test | Result |
|---|---|
| pi-durable storage conformance suite | **23 of 23 pass**, first run, no changes needed to the suite |
| Owner 1 answers, owner 2 reopens and continues | Pass. Owner 2 answered "teal" to "what is my favourite colour?" |
| Resubmit the same `requestId` | The original submission id comes back, already `done`. 0 commits |
| Stale owner commits after a newer fence | Rejected (`Owner fence moved`). Stale fence claim rejected |
| Lambda-to-computer handoff | Pass (below) |
| Kill mid model stream | Pass. The partial (363 chars) became a `pi.assistant` entry with `stopReason: aborted`, then the same messages were resent and answered |
| Kill mid tool call, `replay: "safe"` | The tool reran on the new owner: started twice, finished once. One result |
| Kill mid tool call, `replay: "unsafe"` | No rerun. The model got an `interrupted` error result: "Tool run_terminal was interrupted and may have partially run" |
| Attributed message from another participant | Pass. "The deploy window is Friday at 3pm, and Bea told us." |
| Approval-style gate | Pass. A `beforeTool` hook returned `{ block }`. The model got "Tool call blocked: needs approval: ..." and asked for confirmation |
| Non-owner message during a busy turn | Pass through a mailbox (below). A direct commit from a second handle was rejected |
| 101 items, 4.2 MB, 410 KB item | Each rejected before sending |

### Per turn (gpt-5-nano)

| Turn | Commits | Max items per commit | Bytes written | Stream batches | Stream bytes |
|---|---|---|---|---|---|
| First turn, new conversation | 8 | 13 | 17 KB | -- | -- |
| Plain answer | 6 to 7 | 9 | 10 to 14 KB | 5 | 10 KB |
| One tool call (3 s tool, streamed output) | 31 | 9 | 51 KB | 18 | 32 KB |
| Tool call blocked | 18 | 9 | 42 KB | 10 | 32 KB |
| Tool call plus a mid-turn steer | 21 | 10 | 39 KB | 13 | 31 KB |

- Reopening an existing conversation took 7 read round trips and no commits.
- The largest item was 18 KB: a `pi.live` revision during a long streamed
  answer.
- No real commit came near 100 items. The largest number of items in one
  commit grows with the number of tool calls in one model response
  (roughly calls + 4). So a response with about 95 parallel tool calls would
  exceed the limit.
- A single entry over 400 KB, for example a very long answer or a huge tool
  result, would be rejected. pi-durable already truncates tool output
  (`outputLimits`). Model answers have no such cap.
- Commit latency against moto was 10 to 25 ms p50 and 26 to 105 ms p95.
  **This is not representative** of DynamoDB in a region, where a
  transaction of this size is typically tens of milliseconds. Partials
  commit at most every 100 ms, so commit latency limits how fast the
  stream updates.

## The Lambda-to-computer handoff

This is the core product question: a Lambda starts a conversation, the
computer comes up, and Pi continues the same conversation.

What ran (`scripts/handoff.ts`):

1. Owner A (fence 1, "Lambda", no executor for computer tools) admitted the
   message with `requestId`. The model called `run_terminal`. A's tool
   implementation does not execute: it signals "parked" and waits for its
   invocation to be cancelled. A closed the Harness 2.6 s after opening.
2. After A closed, the generation task was `waiting` on `tools` and the tool
   task was `running` at checkpoint `execute`. Owner B saw that tool task as
   `pending` at `execute`.
3. Owner B (fence 2, "computer") opened the same storage and called
   `resume()`. The tool ran **once**. The model got the result and answered
   with the real output, 2.5 s after B opened.
4. One transcript: user, system, assistant (tool call), tool result,
   assistant. The provider session id (`pi.provider`) was the same for A and
   B, so the provider prompt cache carries over.
5. A handle still holding fence 1 then tried to commit and was rejected.

The pi-durable mechanisms that make this work:

- **Intent before effect.** The `pi.tool` task commits its checkpoint
  `{ phase: "execute", arguments, replay }` before `execute()` runs.
- **Close is not abort.** `Harness.close()` stops every invocation without
  writing an outcome (spec section 5.4). A throw after the invocation is
  signalled does not become a tool error. The task stays at `execute`, and
  `running` reads back as `pending` on reopen.
- **Recovery replays only when safe.** On reopen, `execute` reruns the tool
  only if both the stored and the current policy are `replay: "safe"`.
  Otherwise the model gets an `interrupted` error result.
- **The generation waits durably.** It sits `waiting` on its tool tasks
  (`phase: "tools"`) and resumes when they are terminal, on whichever owner
  is running then.

What is missing:

- **No explicit "deferred to another executor" state.** Parking reuses crash
  recovery, so a computer tool must be declared `replay: "safe"`. B cannot
  tell "A parked before running it" from "B crashed halfway through". A real
  computer tool needs its own idempotency marker (for example an action id
  in a task document) or a parking hook upstream.
- **`beforeTool` runs on A.** Approval and argument rewriting happen on the
  owner that first sees the call. That is fine for policy hooks. It is
  wrong if the hook needs the computer.
- The tool and its schema must be registered on A too, so the model sees
  the tool from the first request. Only `execute()` differs by capability.

## Watching a turn: what the stream would carry

`watchEvents()` turns each commit into one batch of agent events. A
per-turn SSE stream can forward these batches unchanged:

| Event | Maps to ([Messaging](MESSAGING.md)) |
|---|---|
| `submission`, `inbox_update` | `channel.message.created`, queued steer or follow-up |
| `run_start` / `run_end` | `turn.started` / `turn.completed` |
| `turn_start` / `turn_end` | one model round (no current Chatticus event) |
| `message_start` / `message_update` / `message_end` | `turn.token` (text and thinking deltas, tool-call argument deltas) |
| `tool_execution_start` / `_update` / `_end` | `tool.call`, tool output, `tool.result` |
| `usage_changed` | budget metering |
| `snapshot` | late join or a client that fell more than 100 batches behind |

The initial snapshot holds the whole active transcript. It grew from 0.4 KB
to 34 KB over four short turns. A per-turn stream should skip it, because
the client already has the channel, and send only batches. Missing from the
events: a `turn.waiting` reason (computer booting) and `approval.required`.
Both would be Chatticus events derived from our own documents.

## Non-owner mutations

While an owner holds a conversation, nobody else can commit to its storage.
Measured: a second handle's commit during a busy turn was rejected. So a
human posting or an approval decision cannot write Pi storage directly. Two
ways in:

- **Mailbox (tested).** The HTTP handler writes the message to a mailbox
  item outside Pi storage (`MB#<storage>`, keyed by message id). The owner
  drains the mailbox and calls `submit({ type: "input", whenBusy: "steer",
  requestId: <message id> })`. In the test, Bea's message arrived during a
  tool round, was placed after it, and the final answer used it. The
  `requestId` makes a re-drain after a crash harmless. A passive message
  (not addressed to the bot) would be `submit({ type: "write", entry })`.
- **Owner-free admission.** When no owner is live, the handler can briefly
  become the owner itself (claim the next fence, submit, close) and enqueue a
  turn.

The open part is the edge between these two. The handler has to know
whether an owner is live: with a fence lease or a heartbeat, or by always
using the mailbox and having every owner drain it at open and before
closing. Always using the mailbox is the simplest. It still needs a test
with concurrent writers.

Approvals have the same shape. `beforeTool` can only allow, rewrite or block
**right now**. A hook that waits for a human would keep the owner alive for
hours. That rules it out for Lambda. An approval is therefore either a block
plus a later re-request after the decision, or a parked tool (as in the
handoff) whose next owner checks an approval document before executing.

## The language boundary

- Today: the Python control plane owns organizations, auth, membership,
  budgets, routines, the computer lifecycle, turns and the transcript.
  `web/`, `infra/` and the harnesses are TypeScript. The worker-to-control-plane
  boundary is already HTTP.
- pi-durable, pi-ai and Chord are TypeScript only. Storage access is a
  TypeScript API, and the storage layout (Chord deltas, ID namespace) is
  pi-durable's private format. Python reading or writing these items would
  be a second reader of someone else's format. The working rules forbid
  dual readers.
- So the cut follows the storage. Whatever reads or writes a Pi
  conversation is TypeScript. Everything else can stay where it is and talk
  to it over HTTP.

## Recommendation

The spike holds. pi-durable runs on a DynamoDB storage with one
`TransactWriteItems` per commit, passes its own conformance suite, survives
`SIGKILL` mid stream and mid tool, and hands a parked tool call from a
computerless owner to a computer owner with one execution and one
transcript. The fence maps onto it cleanly. Nothing measured contradicts
the staged plan, which this note recommends:

1. **This spike** proves pi-durable on a DynamoDB storage with one
   short-lived owner per turn, the Lambda-to-computer handoff and crash
   resume. No product code before this report. Before step 2, rerun
   conformance on DynamoDB Local and run one turn against a real table in
   the development account, to get real commit latency.
2. **If it holds**, build a TypeScript conversation service that embeds
   pi-durable and owns everything conversational: messages, turns,
   approvals, tasks and grants as pi-durable documents, and the per-turn
   stream fed from `watchEvents()`. Python keeps organizations, auth,
   membership, budgets, routines and the computer lifecycle, and talks to
   it over HTTP. Only the TypeScript side reads or writes Pi storage.
3. **Later**, decide whether the rest of the control plane moves to
   TypeScript, based on what remains and how stable the pi-durable API is.
   The package is marked experimental and "changes without notice". Pin it
   exactly and run the conformance suite in CI.

## Open questions

- Real DynamoDB: commit latency, and cost per turn (6 to 31 transactional
  commits, each costing twice the write units).
- Parking: a first-class "defer to computer" path (a pi-durable hook or a
  tool-level idempotency key) instead of `replay: "safe"` plus close.
- Mailbox versus owner-free admission when no owner is live, and the
  concurrent-writer test for it.
- Long answers: an assistant entry over 400 KB fails the commit. Do we need
  a cap, or entry spill to S3?
- Partition growth: local indexes cap an item collection at 10 GB per
  conversation. Compaction keeps old entries, so very long-lived channels
  need a reset-to-new-storage policy.
- Throttle: partials and tool output commit at most every 100 ms. The stream
  can only be as smooth as commit latency allows.
- API stability of an experimental 1.0.x package, and how far we depend on
  internals (the storage format) rather than the documented interface.
