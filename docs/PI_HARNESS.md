# Pi harness

Design note for Kanbus story `chatticus-6c4d24` (epic `chatticus-9f09c5`).
Measured 2026-10-04 against `@earendil-works/pi-durable` 1.0.2 (Pi monorepo
`2003871`). The code is a throwaway spike in
[`spikes/pi-durable-6c4d24`](../spikes/pi-durable-6c4d24/README.md). No
product code depends on it.

## What we want

One durable engine for a bot's conversation that fits the serverless shape
in [Design challenges](DESIGN_CHALLENGES.md) and [Messaging](MESSAGING.md):
no always-on process, a stream scoped to one turn, and a turn that can begin
on a Lambda and continue on the computer.

The plan under test:

- One pi-durable storage per bot conversation (bot x channel). Its data lives
  in S3 as one immutable object per commit, found by convention. DynamoDB
  holds only the index that makes a commit visible.
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

## The storage: S3 data, DynamoDB index

`src/indexed-storage.ts`. The first version (`src/dynamodb-storage.ts`, kept
as the cost baseline) stored every record body in DynamoDB.

### S3: one object per commit

```text
s3://<bucket>/conversations/<storage>/commits/<seq:012>-<fence:08>.json
  { "seq": 12, "fence": 3, "token": "<uuid>", "writes": [ ...every StorageWrite of the commit... ] }
```

- The key is derived from the commit sequence and the committing owner's
  fence, so a reader needs no stored path. Zero padding keeps a listing in
  commit order.
- Objects are immutable. An owner caches every object it reads or writes for
  its lifetime and fetches missing ones in parallel.
- Document copies (forks) are resolved to their base value before the object
  is written, so an object never refers to another object.
- With the data in S3, DynamoDB's 400 KB item limit and 4 MB transaction
  limit no longer apply to payloads. Measured: a 410 KB entry and a 4.2 MB
  commit both committed (`results/limits-indexed.json`). Both are rejected by
  the DynamoDB-only storage.

### DynamoDB: the index

One table, `pk`/`sk`, plus three local secondary indexes (`l1`, `l2`, `l3`).
Local indexes support strongly consistent reads, which the storage contract
requires. One storage is one partition, `pk = PI#<tenant>#<bot>#<channel>`.
Every record item carries a pointer `c` (commit seq), `f` (fence) and `p`
(position of the write in the commit object).

| `sk` | Holds (besides the pointer) | Index keys |
|---|---|---|
| `META` | commit `seq`, ID high-water mark, last commit `token` | -- |
| `OWNER` | current `fence` | -- |
| `R#<id>` conversation | the whole record (ids only: parent, owner) | `l1 C#<id>`, `l2 CT#<ownerTask>#<id>`, `l3 CC#<ownerConversation>#<id>` |
| `R#<id>` entry | conversation id | `l1 E#<conversation>#<id>`; with a head also `l2 H#<conversation>#<id>` |
| `R#<id>` task | conversation, kind, abort and background flags | `l1 T#<id>`, `l2 TS#<status>#<id>` |
| `R#<id>` submission | conversation id | `l1 S#<id>`, `l2 SS#<status>#<id>`, `l3 SR#<conversation>#<hash(requestId)>#<id>` |
| `R#<id>` document | lifecycle record (kind, key, scope, created, retired), latest version and revision seq | `l1 D#<hash(scope)>#<id>`, `l2 DA#<hash(address)>#<id>` |
| `V#<document>#<seq>` | base or delta flag | -- |

- **Item size.** The largest index item written was 361 bytes (measured over
  every phase script). Index items carry no message text, tool output or
  document value.
- **Global ID namespace.** Every record is keyed `R#<id>`, so a collision is
  a key collision. Conversations, entries and documents are written with
  `attribute_not_exists(pk)`. Tasks and submissions replace themselves with
  `attribute_not_exists(pk) OR t = :type`.
- **Ancestry-aware entries.** Reads walk the fork chain (`parent.at` caps
  each ancestor) and query `l1` newest-first per conversation. Filters for
  tasks and submissions run on index attributes, so a scan reads S3 only for
  the records it returns.
- **Point-in-time documents.** A read queries `V#<id>#` downward from the
  requested seq (for a current read, the record's latest revision seq) to
  the newest base, then fetches those commit objects in parallel and applies
  the deltas. Nothing is ever deleted, so this is a consistent point-in-time
  read. The DynamoDB-only version had to delete superseded revisions and
  could race a reader (see open questions).

### The commit protocol

1. Prepare: read what validation needs from the index (document records and
   address occupancy; 1.2 to 2.1 read round trips per commit, measured).
2. `PutObject` the commit object with `If-None-Match: *`, so a key is never
   overwritten. The fence in the key means only this owner ever writes it.
   If the key already exists with this commit's token, it is this commit's
   own earlier attempt. If it has another token, the storage reads `META`:
   when `META.seq >= seq` the object is committed data and the commit fails
   with `OwnershipLost` without deleting anything; otherwise it is this
   owner's orphan from a commit whose transaction failed, and it is deleted
   and replaced. An S3 409 `ConditionalRequestConflict` means a concurrent
   write to the same key is still in flight, which with the fence in the key
   can only be this owner's own earlier attempt; it is retried with backoff
   and resolves to a success or a same-token 412.
3. One `TransactWriteItems` with the index items, the `META` update
   conditioned on `seq = <last seq this owner saw>` (which also stores the
   token), and, when fenced, a `ConditionCheck` on `OWNER.fence`.
4. The transaction carries the token as `ClientRequestToken`. The storage
   itself retries throttling, timeouts and `TransactionConflict` with the
   same token. If a retry finds the `META` condition failed, it re-reads
   `META`: when the stored token is its own, the first attempt landed and
   only the response was lost, so the commit counts as done. The check has
   three outcomes: committed, not committed, or unknown (the read itself
   failed). Unknown throws `CommitOutcomeUnknown`, an `OwnershipLost`
   subtype that is fatal to the Session, and the storage does not delete the
   object: it may be committed, so it is left for the next owner to find and
   for the sweeper.
5. The SDK client uses `maxAttempts: 1`. In the first version that was
   load-bearing: an SDK retry after a lost response would have come back as
   a false "another owner committed". Production must keep SDK retries off
   for `TransactWriteItems` (or make them reuse the token) and leave retrying
   to the storage as above.

Readers only follow the index. An object whose transaction never landed is
invisible.

### Failure cases

| Failure | What happens | Measured |
|---|---|---|
| Transaction rejected (ID collision, size) | `StorageRejected`; the storage deletes its own object | Object gone (`results/orphans.json`) |
| Fence moved before the transaction | `OwnershipLost`; the object is deleted | Object gone |
| Crash between `PutObject` and the transaction | The object stays as an orphan. The next commit by the same owner at that seq replaces it; another owner uses a different key | Replaced and committed |
| `PutObject` fails | Nothing committed; pi-durable sees a plain error and poisons the Session | -- |
| Transaction outcome unknown after retries | The token check decides; if still unknown, `CommitOutcomeUnknown` poisons the Session and the object is kept. A landed commit is then found by the next owner | Not reproducible on moto |
| Object deleted or unreadable after commit | Reads of those records fail. This must not happen: no lifecycle rule may expire `commits/` | -- |

**Orphan rule.** The sweeper reads `META` and `OWNER` first, then checks
references, so the values it acts on can only be older than the truth in the
safe direction (both only rise). It may delete `commits/<seq>-<fence>.json`
only when no index item points at `(seq, fence)` and either of these holds:

1. `META.seq >= seq`. The commit's `META` condition needs
   `META.seq = seq - 1`, so a late commit of this seq can never succeed.
2. `OWNER.fence > fence`. Fences only rise, so the commit's `ConditionCheck`
   on `OWNER.fence = fence` can never succeed.

There is no time-based clause. An object with `seq > META.seq` whose fence is
still the current `OWNER.fence` may be an in-flight commit of a live (or
momentarily stalled) owner and is kept; it becomes deletable by clause 1 or 2
as soon as the sequence passes it or a new owner raises the fence.
`results/orphans.json` shows both clauses and the kept case. An S3 lifecycle
rule cannot express "unreferenced", so the sweeper is a small scheduled job.
Orphans arise only from a crash between steps 2 and 3, so it can be rare.

## Ownership and the fence

- `claimOwnership(fence)` raises `OWNER.fence` if the new value is higher.
- The storage then commits only with `fence = mine`. An owner that has lost
  the fence gets `OwnershipLost: Owner fence moved` and cannot write. So does
  an owner whose `META` condition fails for someone else's commit, or whose
  transaction keeps hitting `TransactionConflict` (for example against a
  concurrent `claimOwnership`).
- `OwnershipLost` is deliberately **not** a `StorageRejected`. pi-durable
  treats `StorageRejected` as an ordinary rollback and keeps going; any other
  commit error poisons the Session. Measured (`scripts/fence-loss.ts`): the
  fence was raised while the stale owner's tool was running. Its next commit
  failed with `OwnershipLost`, after which it made no further commit
  attempt, started no tool and sent no model request in the 18 s observed.
  Its `submission.wait()` never settled, so a host must close a stale owner
  itself rather than wait for it. The next owner resumed and finished the
  turn.
- The Chatticus per-turn fence maps onto this directly. An attempt claims the
  turn (`attempt.claimed`) and that fence value is the storage fence.
  Relinquishing the attempt is closing the Harness.

## Results

All runs used moto 5.2.3 for both DynamoDB and S3 (path-style, dummy
credentials). Amazon DynamoDB Local was requested, but its container never
answered on port 8000 in this session (the pull was stopped after 30
minutes). moto honors `If-None-Match: *` on `PutObject` (412 on the second
write, `results/s3-conditional.json`).

Neither moto nor DynamoDB Local exercises `TransactionConflict`, throttling,
SDK retries or per-partition throughput limits. The retry,
idempotency-token and ownership-loss paths are therefore untested against
real behavior. Only a run against a real table covers them.

| Test | Result |
|---|---|
| pi-durable storage conformance suite | **23 of 23 pass** for the S3-plus-index storage, and 23 of 23 for the DynamoDB-only baseline (`results/conformance-moto.txt`, 46 tests) |
| Owner 1 answers, owner 2 reopens and continues | Pass. Owner 2 answered "teal" to "what is my favourite colour?" |
| Resubmit the same `requestId` | The original submission id comes back, already `done`. 0 commits |
| Stale owner commits after a newer fence | Rejected with `OwnershipLost` (`Owner fence moved`). Stale fence claim rejected |
| Fence raised while an owner is mid tool call | The stale owner's next commit failed with `OwnershipLost`; it then did nothing more. The next owner reran the replay-safe tool and finished |
| Lambda-to-computer handoff | Pass (below) |
| Kill mid model stream | Pass. The partial (262 chars) became a `pi.assistant` entry with `stopReason: aborted`, then the same messages were resent and answered |
| Kill mid tool call, `replay: "safe"` | The tool reran on the new owner: started twice, finished once. One result |
| Kill mid tool call, `replay: "unsafe"` | No rerun. The model got an `interrupted` error result: "Tool run_terminal was interrupted and may have partially run" |
| Attributed message from another participant | Pass. "Friday at 3pm, according to Bea." |
| Approval-style gate | Pass. A `beforeTool` hook returned `{ block }`. The model got "Tool call blocked: needs approval: ..." and said so |
| Non-owner message during a busy turn | Pass through a mailbox (below). A direct commit from a second handle was rejected (`OwnershipLost: Commit sequence moved`) |
| Orphans | A rejected or fenced-out commit leaves no object; a crashed attempt's object is replaced (`results/orphans.json`) |
| 101 transaction items | Rejected before sending (both storages). 410 KB entry and 4.2 MB commit: committed on S3-plus-index, rejected on DynamoDB-only |

### Per turn (gpt-5-nano, S3-plus-index storage)

| Turn | Commits | Max items per commit | Bytes written (index + objects) | Stream batches | Stream bytes |
|---|---|---|---|---|---|
| First turn, new conversation | 8 | 13 | 20 KB | -- | -- |
| Plain answer | 7 | 9 | 15 to 16 KB | 5 | 10 KB |
| One tool call (3 s tool, streamed output) | 32 | 9 | 62 KB | 19 | 34 KB |
| Tool call blocked | 45 | 9 | 91 KB | 27 | 52 KB |
| Tool call plus a mid-turn steer | 21 | 10 | 49 KB | 13 | 35 KB |

- The commit count of a turn varies with the model: how many 100 ms progress
  windows its answer and the tool's output span, and how many model requests
  it makes. The same tool turn took 19 to 43 commits across runs.
- No real commit came near 100 items. The item count grows with the number
  of tool calls in one model response (roughly calls + 4), so a response
  with about 95 parallel tool calls would exceed the limit. That limit
  remains with the index.
- Commit latency against moto was 31 to 75 ms p50 and 54 to 787 ms p95 for
  the S3-plus-index storage (one `PutObject` plus one transaction), against
  12 to 41 ms p50 for the DynamoDB-only storage. **Neither is
  representative** of AWS in a region. In a region expect roughly an S3 PUT
  plus a small transaction per commit, tens of milliseconds. Partials commit
  at most every 100 ms, so commit latency limits how fast the stream
  updates.

### Reopen

A new owner's `Harness.open` plus `root()` took **7 DynamoDB reads and 0 S3
GETs** on both storages (`results/cost.json`): the Session loads lazily. Reading
the whole transcript after two turns took 2 index queries and 9 S3 GETs
(one per commit that holds an entry), fetched in parallel. The moto timings
(43 ms reopen, 28 ms transcript) say nothing about AWS.

The cost that grows is not reopen but the first model request of each turn:
it needs every visible entry, so a fresh owner fetches one object per commit
that holds an entry, about 4 to 5 per turn of history. A periodic snapshot
object (`conversations/<id>/snapshots/<seq>.json` holding the visible entries
and current documents) would make that one GET plus the recent commits. It
is not implemented in the spike; it should be before production. Request
cost is flat per turn only with that snapshot object. Without it (the spike
as built), a fresh owner's first model request fetches about 4 to 5 commit
objects per turn of history, so GETs and first-token latency grow linearly
with conversation length. The cost projections below count only the spike's
two-turn runs and omit these growing GETs.

## Cost: DynamoDB-only versus S3 data with a DynamoDB index

Prices, us-east-1, checked 2026-10-04 on
[DynamoDB on-demand pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/)
and [S3 pricing](https://aws.amazon.com/s3/pricing/):

- DynamoDB on-demand: $0.625 per million write request units, $0.125 per
  million read request units, $0.25 per GB-month (Standard table class; the
  first 25 GB are free). A transactional write costs 2 WRU per started KB.
  Writes to a local secondary index are billed as writes too.
- S3 Standard: $0.005 per 1,000 PUT, $0.0004 per 1,000 GET, $0.023 per
  GB-month (first 50 TB).

Request units are estimated by the spike's meter from each request (moto
does not report consumed capacity): 2 WRU per started KB per transaction
item plus 1 per local index the item lands in, and 1 RRU per started 4 KB of
strongly consistent reads. The meter undercounts index writes that move an
item between index keys (a delete plus a put). One run each, same prompts
(`scripts/cost.ts`, `results/cost.json`):

| Turn | Storage | Commits | WRU | RRU | S3 PUT | Requests per 1,000 turns |
|---|---|---|---|---|---|---|
| Plain answer | DynamoDB-only | 7 | 120 | 46 | 0 | **$0.081** |
| Plain answer | S3 + index | 7 | 99 | 42 | 7 | **$0.102** |
| One tool call | DynamoDB-only | 31 | 479 | 182 | 0 | **$0.322** |
| One tool call | S3 + index | 30 | 382 | 141 | 30 | **$0.406** |

Per commit, the S3-plus-index storage costs about $0.0000135 to $0.0000146
and the DynamoDB-only storage about $0.0000104 to $0.0000115: **the index
version costs about 25 to 30% more in requests**. The reason: at these payload
sizes (a few KB per commit) WRUs are set by the per-item minimum, not by the
payload, so moving the payload out of DynamoDB saves only 2 to 3 WRU per
commit, while each commit adds one S3 PUT ($0.000005, the price of 8 WRU).

| Resident data after setup and both turns | DynamoDB-only | S3 + index |
|---|---|---|
| DynamoDB billable bytes (items + 100 bytes each, times local indexes) | 62 KB | 25 KB |
| S3 bytes | 0 | 53 KB (38 objects) |
| Per 1,000 turns per month (setup spread over the two turns) | **$0.0073** | **$0.0035** |

Storage per GB-month of conversation: DynamoDB-only pays $0.25 on every
billable byte, including the copies in three local indexes; the index
version pays $0.25 on a third as many DynamoDB bytes and $0.023 on the rest.

So:

- **For short turns, the index version is not cheaper at first.** Its extra
  request cost per tool turn ($0.000084) equals its storage saving
  ($0.0000059 per turn per month) after about 14 months of retention; for a
  plain turn ($0.000021 against $0.0000016 a month), after about 13 months.
  Formula: break-even months = extra request cost per turn / storage saved
  per turn per month. Extra request cost is S3 + index minus DynamoDB-only
  from `results/cost.json` at $0.625/M WRU, $0.125/M RRU, $0.005 per 1,000
  PUTs: plain $0.000102125 - $0.00008075 = $0.0000214, tool $0.000406375 -
  $0.000322125 = $0.0000843. Storage saved per month is (DynamoDB-only bytes
  x $0.25 - index bytes x $0.25 - S3 bytes x $0.023) / 2^30 using the
  per-turn bytes in the projection table: plain (12,512 x 0.25 - 4,491 x 0.25
  - 11,715 x 0.023) / 2^30 = $0.0000016, tool (41,150 x 0.25 - 12,093 x 0.25
  - 39,794 x 0.023) / 2^30 = $0.0000059. Break-even: 0.0000214 / 0.0000016 =
  13.2 months (plain), 0.0000843 / 0.0000059 = 14.2 months (tool). An earlier
  report of about 4 and 20 months was wrong and appears nowhere else; the
  figures here use 2^30 bytes per GB (with 10^9, 12.3 and 13.3 months).
  See the household projection below.
- **It wins when payloads are large or kept long:** long answers, large tool
  output, images, and years of history. It also removes the 400 KB item and
  4 MB transaction limits, which is a correctness gain, not a cost one.
- **Both are cheap in absolute terms:** under half a dollar per 1,000 tool
  turns for storage requests, small next to the model cost of the same
  turns.
- **Cheapest next steps, if cost matters:** fewer commits per turn (pi-durable
  commits partials every 100 ms; a longer throttle cuts commits roughly in
  proportion), fewer index items per commit (the `pi.live` revision plus its
  record update are 2 of the typical 9), and the snapshot object above so
  that cold reads do not grow with history.

## Long-term storage

**Decision:** payloads stay in S3 and DynamoDB is only the index. The
concern is not the cost of one turn but storage that compounds: every turn
ever taken stays resident and billed every month. DynamoDB charges $0.25
per GB-month for every billable byte, including each local-index copy; S3
Standard charges $0.023.

### Projection for one household

100 plain turns and 20 tool turns a day. Bytes per turn are the measured
resident growth from `scripts/cost.ts` (`results/cost.json`, one run each,
first-turn setup subtracted):

| Per turn | DynamoDB-only | S3 + index: DynamoDB | S3 + index: S3 |
|---|---|---|---|
| Plain | 21,144 - 8,632 = 12,512 B | 12,848 - 8,357 = 4,491 B | 12,965 - 1,250 = 11,715 B |
| Tool call (31 and 30 commits) | 62,294 - 21,144 = 41,150 B | 24,941 - 12,848 = 12,093 B | 52,759 - 12,965 = 39,794 B |
| Per day (100 plain + 20 tool) | 1,251,200 + 823,000 = 2,074,200 B | 449,100 + 241,860 = 690,960 B | 1,171,500 + 795,880 = 1,967,380 B |
| Per 30-day month, GiB (/ 2^30) | 0.0580 | 0.0193 | 0.0550 |

The stored data after N months is N times the monthly growth. The bill for
month N is that stock times the price. The cumulative bill is the price
times the monthly growth times N(N+1)/2. Prices as cited above; the 25 GB
DynamoDB free tier is per account and ignored.

| After | Stored: DynamoDB-only | Stored: S3 + index | Bill that month: DynamoDB-only | Bill that month: S3 + index | Cumulative: DynamoDB-only | Cumulative: S3 + index |
|---|---|---|---|---|---|---|
| 1 month | 0.058 GiB | 0.019 + 0.055 GiB | 0.058 x 0.25 = $0.014 | 0.019 x 0.25 + 0.055 x 0.023 = $0.006 | $0.014 | $0.006 |
| 12 months | 0.695 GiB | 0.232 + 0.660 GiB | $0.174 | $0.073 | 0.25 x 0.0580 x 78 = $1.13 | (0.25 x 0.0193 + 0.023 x 0.0550) x 78 = $0.48 |
| 36 months | 2.086 GiB | 0.695 + 1.979 GiB | $0.522 | $0.219 | 0.25 x 0.0580 x 666 = $9.65 | (0.25 x 0.0193 + 0.023 x 0.0550) x 666 = $4.06 |

Requests for the same household are about $0.44 a month (DynamoDB-only)
and $0.55 (S3 + index), flat over time only with the snapshot object (without
it the S3 layout's GETs grow with history, at $0.0000004 each): 100 x $0.0000808 + 20 x $0.000322
a day against 100 x $0.000102 + 20 x $0.000406. The S3 layout's monthly bill
(storage plus requests) drops below DynamoDB-only's around month 14 and its
cumulative bill around month 26. That crossover comes earlier with
any stage-2 item below; with item (2), the DynamoDB part stops growing.

### Stage-2 requirements

1. **S3 lifecycle.** Commit and segment objects of conversations that have
   been idle (for example 30 days) move to S3 Intelligent-Tiering or
   Glacier Instant Retrieval. Both keep millisecond reads, so a returning
   conversation needs no restore. Never expire `commits/` or `segments/`.
2. **Compaction of idle conversations.** When a conversation has been idle
   and has no live task, a job folds its commit objects into one segment
   object and replaces its per-record index items with one manifest item,
   so the DynamoDB footprint per conversation stays roughly constant.

   ```text
   s3://<bucket>/conversations/<storage>/segments/<throughSeq:012>.json
     { "throughSeq": 4812, "records": { "<id>": <record> }, "revisions": { "<doc>": [<base>, <deltas>...] } }

   DynamoDB pk = PI#<storage>, sk = MANIFEST
     { "segment": "segments/000000004812.json", "throughSeq": 4812, "bytes": 1834221,
       "liveTasks": 0, "nextId": 90311, "requestIds": "<bloom or hash set of recent requestIds>" }
   ```

   Reads resolve through the manifest. An id with an `R#<id>` item is read
   as today, from the commit object it points at. Without one, and with
   `id` at or below the segment's range, it is read from the segment, which
   is fetched once and cached. Ordered scans (entries, tasks, submissions,
   documents) merge the segment's sorted lists with the index queries above
   `throughSeq`. The first commit after reopening writes index items again,
   only for new records. Compaction itself runs as an owner holding the
   fence: it writes the segment, then in one transaction deletes the folded
   index items (in batches of under 100) and writes `MANIFEST`. A crash
   leaves either the old index or the new manifest, never neither. Folded
   commit objects are deleted only after the manifest commits.
3. **DynamoDB Standard-IA for the index table.** Standard-IA trades lower
   storage price for higher request price. Evaluate it once compaction
   exists, because the index's balance of request cost to storage cost
   decides it.
4. **Fewer commits per turn.** Commits dominate request cost: 7 for a plain
   turn, 30 or more for a tool turn, most of them 100 ms partial and
   tool-output updates of `pi.live`. Options: a longer partial throttle in
   pi-durable, coalescing live updates when nobody is watching the stream,
   and fewer index items per commit (the `pi.live` revision and its record
   update are 2 of a typical 9).

## The Lambda-to-computer handoff

This is the core product question: a Lambda starts a conversation, the
computer comes up, and Pi continues the same conversation.

What ran (`scripts/handoff.ts`):

1. Owner A (fence 1, "Lambda", no executor for computer tools) admitted the
   message with `requestId`. The model called `run_terminal`. A's tool
   implementation does not execute: it signals "parked" and waits for its
   invocation to be cancelled. A parked 2.6 s after opening and closed.
2. After A closed, the generation task was `waiting` on `tools` and the tool
   task was `running` at checkpoint `execute`. Owner B saw that tool task as
   `pending` at `execute`.
3. Owner B (fence 2, "computer") opened the same storage and called
   `resume()`. The tool ran **once**. The model got the result and answered
   with the real output, 3.8 s after B opened.
4. One transcript: user, system, assistant (tool call), tool result,
   assistant. The provider session id (`pi.provider`) was the same for A and
   B, so the provider prompt cache carries over.
5. A handle still holding fence 1 then tried to commit and was rejected with
   `OwnershipLost`.

"Exactly once" held here because owner A never reached the tool's real
`execute()` work: it parked before doing anything. A real computer tool
still needs its own idempotency marker, because a computer owner that
crashes mid-execution looks identical to a parked call.

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
to 42 KB over four short turns. A per-turn stream should skip it, because
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
  TypeScript API, and the storage layout (Chord deltas, commit objects, ID
  namespace) is pi-durable's private format. Python reading or writing
  these items or objects would be a second reader of someone else's format.
  The working rules forbid dual readers.
- So the cut follows the storage. Whatever reads or writes a Pi
  conversation is TypeScript. Everything else can stay where it is and talk
  to it over HTTP.

## Recommendation

The spike holds. pi-durable runs on S3 commit objects with a small DynamoDB
index (and, as a baseline, on DynamoDB alone), passes its own conformance
suite on both, survives `SIGKILL` mid stream and mid tool, stops a
fenced-out owner, and hands a parked tool call from a computerless owner to
a computer owner with one execution and one transcript. The fence maps onto
it cleanly.

One measured result contradicts the reason given for the S3 move: at
Chatticus's payload sizes, keeping payloads out of DynamoDB does **not**
lower per-turn cost; it raises request cost by about 25 to 30% and lowers
storage cost by about 60%, breaking even after roughly 13 (plain) to 14 (tool)
months of retention. The S3 layout is still the better default because it
removes the 400 KB and 4 MB limits and its cost advantage grows with
payload size and retention, but it should not be justified as a per-turn
saving. The decision to keep it rests on long-term storage (see
[Long-term storage](#long-term-storage)).

The staged plan stands:

1. **This spike** proves pi-durable on S3 plus a DynamoDB index with one
   short-lived owner per turn, the Lambda-to-computer handoff and crash
   resume. No product code before this report. Before step 2, rerun
   conformance on DynamoDB Local and run one turn against a real table and
   bucket in the development account, to get real latency, consumed
   capacity, and the retry and conflict paths.
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

- Real AWS: latency of `PutObject` plus the transaction per commit, consumed
  capacity versus the spike's estimate, and the throttling, conflict and
  lost-response paths that no emulator exercises.
- Snapshot objects, so a cold owner's first model request costs one GET plus
  recent commits instead of one GET per commit of history.
- The orphan sweeper: schedule, and a test with a real crash between the
  object write and the transaction.
- Parking: a first-class "defer to computer" path (a pi-durable hook or a
  tool-level idempotency key) instead of `replay: "safe"` plus close.
- Mailbox versus owner-free admission when no owner is live, and the
  concurrent-writer test for it.
- Partition growth: local indexes cap an item collection at 10 GB per
  conversation. With index items under 400 bytes that is tens of millions of
  records, far beyond one channel.
- Fewer commits per turn: the 100 ms partial throttle is pi-durable's; a
  longer one would cut S3 PUTs and index writes.
- The DynamoDB-only baseline's document reads were not point-in-time:
  revision cleanup could delete a base under a concurrent reader (it now
  re-reads up to three times). The S3-plus-index storage never deletes, so
  its reads are consistent.
- API stability of an experimental 1.0.x package, and how far we depend on
  internals (the storage format) rather than the documented interface.
