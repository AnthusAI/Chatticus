# Erasing a deleted message

Status: decided and built, with no route calling it yet. Tickets: chatticus-c02220 (this), chatticus-e4f1f2 (the channel
record). Ryan's decisions (2026-11-02): deletion is real, so no privacy or retention problem is waiting later; the channel
record is the only truth and a bot's Pi session is a disposable copy of it; everything is erased at once except what ages
out within 35 days, with the limits below stated plainly to users.

What users are told is in "What the product says". The design is in the rest.

## What is built

| Piece | Where |
| --- | --- |
| The channel record: one DynamoDB row per message, `msg#<seq>` in the channel's partition, written by `postMessage` and, at turn end, by `commitFinalAnswer` | `domain/messages.ts`, `turn/finalize.ts`, `store/codecs/channel.ts` |
| Tombstone: `tombstoneMessage` empties the body, activity and origin and sets `deleted_at` | `store/dynamo-messaging-store.ts` |
| Drop a session: every DynamoDB item of `PI#<tenant>#<bot>#<channel>` except `OWNER`, every S3 object version under `conversations/<storage>/` | `pi/session-drop.ts` |
| Rebuild a session from the record, by the turn owner at the start of the bot's next turn | `turn/rebuild-dropped-session.ts`, `pi/session-rebuild.ts` |
| Erase one message (tombstone, mailboxes, drop sessions, copy cost detail out, sweep the answer's turn), and finish an erasure that waited on an open turn | `domain/message-erasure.ts` |
| The erasure function: an SQS queue, a one-minute sweep of pending erasures, and its own role | `lambdas/message-erasure.ts`, `infra/lib/control-plane-stack.ts`, role `erasure` of the role access manifest |
| A turn that ends asks for the erasures that waited on it to be finished | `turn/after-turn-erasure.ts`, called from `turn/executor.ts` |
| Per-call cost detail copied out of the session into the messaging table | `ledger/call-cost-copy.ts` |
| Backfill existing channels into the record, and copy their cost detail | `migration/backfill-record.ts`, `migrate-transcripts backfill-record` |
| Scrub old idempotency items | `migration/scrub-idempotency.ts`, `migrate-transcripts scrub-idempotency` (reports only, `--execute` writes) |
| Proof | `features/channel_message_record.feature`, `features/message_erasure.feature`, `features/session_rebuild.feature` |

## Where a message's text can live

Each row says how it was established. "Verified" means a scenario scans the store for the text (the step
`the text ... is held by`), so the claim does not rest on reading code.

| Store | Holds the text? | How established | At erase |
| --- | --- | --- | --- |
| Channel record row (`msg#`) | body, origin assertion; tool arguments and outputs in `activity` of bot answers | verified | tombstoned at once |
| Bot answers to the turn the message started (`in_reply_to_seq`) | the answer, and its activity, are derived from the message | verified | tombstoned at once with it |
| Mailbox items (`MB#<tenant>#<bot>#<channel>`) | body, until the bot reads it; a body over 250,000 bytes is not copied, the item holds a pointer to the record | verified | deleted at once |
| Pi session, S3 commit objects | every entry (user and assistant text, tool calls and results, compaction summaries, submissions, documents) | verified: the text is in the commit objects and in no DynamoDB item of the session | dropped at once, every version |
| Pi session snapshots (`conversations/<storage>/snapshots/`) | packs of commit objects | read from `storage/snapshot-object.ts`; same prefix as the commits | dropped at once with the prefix |
| Pi session, DynamoDB items (`PI#...`) | index items (ids, positions, pointers) | verified: no item holds the text | dropped at once; `OWNER` kept, it holds only the fence |
| Sub-agent conversations | pi-durable keeps a task's child conversations in the same storage (README, "Abort and Subagents"), so they live in the session partition and objects. There is no sub-agent tool yet (chatticus-378eed) | read from the README | gone with the session |
| Compaction summaries | entries of the session (`pi.compaction`), so in the commit objects | README, "Compaction": older entries stay in storage | gone with the session. A summary is never kept across a drop; the rebuilt session is summarized again from the remaining text |
| Post idempotency item (`idem#` in the messaging table) | **the whole message, forever.** It stored the body, and has no expiry. The embedded chat client sends an `Idempotency-Key` on every post (`chat/client/admission.ts:26`) | verified by a scenario before the fix | **fixed in this change**: the item keeps only the channel, sequence, message id and turn id, and a replay reads the message from the record. Items written before this change still hold bodies; `migrate-transcripts scrub-idempotency --execute` removes them (it reports only, by default) |
| Message cache (`MessageBodyCache`) | parsed commit objects, in the memory of each front door instance | `pi/message-cache.ts` | the dropping process evicts its own entries; other instances keep theirs until they recycle. Nothing asks for those keys again, because new commit objects carry a higher fence. Expires with the instance; cannot be reached |
| Turn events (`evt#` rows; streamed tokens, tool arguments and outputs, the completed body) | the reply, and tool text | `store/turn-events.ts`; `TURN_EVENT_TTL_SECONDS` is 24 hours | **erased at once for an erased answer's turn** (the turn id is in the answer's message id, `reply-<turn>`); a turn the erasure cannot name expires in 24 hours plus DynamoDB's TTL lag (AWS documents about 48 hours). The completion event carries no body for a reply over 250,000 bytes |
| Turn record, ledger rows, per-call cost records | ids and counters only; no text | `ledger/`, `domain/turns.ts`: no body field | nothing to erase. The per-call cost detail is copied from the session into the messaging table (`call#` rows of the turn) when the turn's cost is recorded and again before a drop, so the cost API still answers |
| Computer action items (`action-store`) | tool `arguments` and `result` (for example the body of a `send`), with `turn_id` and `channel_id`, and no expiry | `store/codecs/action.ts`; the turn's `act#` index names them | **arguments and result removed at once for an erased answer's turn** (the record stays, for what ran). An action of a turn whose answer is not erased, but that copied the text into a command, is not found |
| Bot memory (`Bot.memory`) | free-form strings, put into every prompt (`turn/prompt.ts:24`) | the only writer is `rememberBotMemory`, which no tool calls today | **rule**: memory holds facts and instructions, never quoted message text. Nothing enforces it, and a paraphrase cannot be found. A future tool that writes memory must say so in its description and must not copy a message |
| CloudWatch logs | `provider_failed` logs the provider's error message (secrets redacted, length-limited), which can echo request text | `turn/executor.ts:293`, `turn/classify-errors.ts` | **expires**: 30 days (`CHATTICUS_LOG_RETENTION`). Not reachable sooner |
| CloudTrail audit bucket | management events only; no data events, so no DynamoDB item or S3 object content | `infra/lib/audit-trail-stack.ts` header | nothing to erase |
| Raw inbound mail (`RawMailBucket`) | the whole email, for messages that arrived by email | `infra/lib/mail-stack.ts`; unversioned, 30-day expiry (`MAIL_RAW_RETENTION_DAYS`) | **expires**: 30 days. The object key is not linked to the message, so no explicit delete |
| Mail already sent to an outside recipient | the text, in someone else's mailbox | | cannot be reached |
| The computer's disk and its snapshots | anything a bot or tool wrote to a file | `infra/lib/snapshot-stack.ts`: versioned, noncurrent versions expire after 30 days | not reached; the content is not linked to a message |
| DynamoDB point-in-time recovery | every item above, as it was | Messaging table `thin-turn-stack.ts:59`, Conversations table `control-plane-stack.ts:170` | **expires**: the recovery window is 35 days (the default; no `recoveryPeriodInDays` is set). A restore creates a new table, so nothing live can read it, but an operator can |
| S3 object versions (PiSessions) | previous versions of an object | `control-plane-stack.ts:184-190`: versioned, **already** has `noncurrentVersionExpiration` of 30 days | erased at once by the drop (it deletes by `VersionId`, delete markers included). The lifecycle rule is the backstop for versions created some other way |
| Model provider | every request the bot's turns sent, including the history and compaction requests | | cannot be reached. OpenAI's own retention applies; I have not verified its current terms |
| Browsers and the embedded chat client | rendered text, local state | | cannot be reached; a deleted row shows as a tombstone on the next read |

The Papyrus copy of this data plane (`Papyrus/infra/amplify-app-shell/lib/chat-stack.ts`) has the same shape and two
differences that matter: PITR on both tables (lines 70, 79), and a versioned bucket (line 95) with **no lifecycle rule**. Its
noncurrent versions would never expire. The explicit drop covers the session objects; the rule is still missing for anything
else that lands in that bucket. Its log groups keep one month.

## What pi-durable allows

From `node_modules/@earendil-works/pi-durable/README.md`:

- A conversation is a transcript of immutable entries (line 82). There is no API to edit or remove an entry.
- `reset()` starts a new context: "The model no longer sees older entries, but they stay in storage" (line 312). So a reset
  hides text from the model and erases nothing.
- Compaction appends a summary entry; "older entries stay in storage" (line 330).
- Entries live in S3 commit objects keyed `commits/<seq>-<fence>.json`; the DynamoDB items are an index
  (`storage/indexed-storage.ts`). Commit objects are written once and never replaced, which is what lets the front door cache
  them as immutable.
- The model replays entry content (`model` messages), so an entry cannot be turned into a pointer to text kept elsewhere
  without changing what the model reads at replay.

## Three ways to erase, compared

**1. Rewrite the log.** Replace the commit objects that hold the text with edited copies.
- Breaks the invariant that commit objects are immutable. The cache would serve the old text; the fence in the key is what
  prevents key reuse today, and a rewrite must reuse the key.
- The DynamoDB index refers to commit sequence numbers and a token per commit; rewriting means a new commit chain, which is a
  rebuild by another name, done by hand on a format the library calls experimental.
- Summaries that absorbed the text stay unless rewritten too, and there is no way to find which words came from which message.
- Old S3 versions keep the original unless deleted by `VersionId`, which is needed in every option.
- Verdict: more code than option 3 and more dangerous, with the same coverage.

**2. Store bodies outside Pi, with a reference.** The Pi entry holds an id; the text lives in one object; erasure deletes that
object.
- The model replays entry content, so the entry must carry the text, or the harness must resolve the reference at replay. The
  library has a `beforeRequest` hook that replaces the messages of one request, so resolution is possible, but then Pi's own
  history, the compaction input, and the provider-facing context all depend on a resolver we would own.
- Compaction would read the references, not the text, unless the hook also runs there; and any summary that was made while the
  text was present contains it.
- Needs a change in how every message enters a session, and a cache that honours deletion. It is the largest change, and it
  still needs the summary problem solved.
- Verdict: right shape only if sessions had to stay and be edited. They do not, once the record is the source (option 3).

**3. Per-message encryption keys, destroyed on delete.** Each body is encrypted with its own key held in a key table; deleting
the key makes every copy unreadable, including in backups.
- The only option that reaches PITR backups and noncurrent versions at once.
- But the model needs plaintext in its context, so each turn decrypts into the request, and the provider receives plaintext.
  Summaries are plaintext derived from several messages and cannot be tied to one key unless every summary is re-derived.
- Needs a key table, a decrypt on every read path (listing, mailbox, session replay), and a per-message KMS or envelope
  scheme. Per-message KMS keys are billed per key; envelope keys held in our own table are cheap but are then the thing to
  protect.
- Verdict: the only way to make backups useless, at the cost of a custom crypto layer on every read. Worth it only if the
  35-day PITR window is unacceptable. It does not touch the provider.

**Recommended: 4. Drop and rebuild.** The channel record is the only truth. A bot's Pi session is a cache of it. Delete means
tombstoning the record and dropping the sessions, which are rebuilt from what remains. It reuses the migration's session
writer, needs no change to Pi or to how entries are written, and removes the summary problem by construction: a rebuilt
session holds no summary, and the next one is made from remaining text.

## What the recommendation erases, expires, and cannot reach

**Erased at once** (the call returns after these are done, and a scenario scans for the text in each):
- the record row, and the rows of bot answers to the turn the message started, as tombstones (sequence, author and
  `deleted_at` remain; body, activity and origin are removed)
- the message's mailbox items for every bot on the channel
- every bot session on the channel that has no open turn: its per-call cost detail is copied out, then its DynamoDB items
  except `OWNER` and every S3 object version and delete marker under its prefix, snapshots included, are deleted. The turn
  owner rebuilds the session from the record, without the text, at the start of the bot's next turn
- the post idempotency copy (new items hold no text)
- the events of the erased answers' turns, and the arguments and results of their computer actions
- the continuation items of a long body

**Waits for an open turn** (the tombstone and the mailbox deletion happen at once; that bot's session stays until its turn ends):
a pending marker is written in one partition, `ERASURE#pending`. When the turn ends, the owner (`turn/after-turn-erasure.ts`)
looks for a marker on the channel and, if there is one, sends `complete` to the erasure queue; the erasure function then
repeats the erasure, which also tombstones the answer the finished turn committed and sweeps its turn. A computer owner has no
erasure queue, and a lost message is possible, so the erasure function also runs once a minute over every pending marker.
Either way the text is gone from the session within about a minute of the turn ending. Until then the running turn may use it.

**When the erased message is the running turn's prompt.** Two cases, both with scenarios:
- The turn is already running, with the prompt in its session: it finishes and commits its answer; the answer is tombstoned
  by the completion, with its events and computer action arguments, and the session is dropped.
- The turn has not started yet (the erasure came before the executor claimed it): the executor finds no prompt in the
  mailbox and fails the turn with "The message this turn was meant to answer is missing." No answer is committed. The failed
  turn also asks for the pending erasure to be completed.

**Expires** (named so nobody claims otherwise):
- turn events: 24 hours plus TTL lag, up to about 48 hours more
- CloudWatch logs: 30 days
- raw inbound mail: 30 days (email-origin messages only)
- DynamoDB point-in-time recovery: 35 days
- in-memory commit caches: until the instance recycles
- computer snapshot noncurrent versions: 30 days (only matters if a tool copied the text to the disk)

**Cannot be reached:** the model provider's retention; mail already delivered to outside people; text a bot copied into a
file on the shared computer, into bot memory, or into a later message it wrote (a reply that quotes the erased message but
answers a different message is not found); a person's own copy or screenshot; browser state.

Derived text is the hard limit. The design erases the answers to the turn the message started. It does not find a bot answer
to a different message that mentions it, and a summary that absorbed it is gone only because every session is rebuilt.

## What the model sees next

A rebuilt session holds every non-deleted record message that the bot had already read, in sequence order: other authors as
attributed lines (`<author id>: <body>`), the bot's own earlier answers as its answers (provider `openai`, model `migrated`,
as the migration wrote them). Messages still in the bot's mailbox are left out of the rebuild and delivered by the mailbox as
before, so nothing is read twice. Tombstoned messages are left out entirely; their sequence numbers are simply absent.

Scenarios prove it: after an erase, the model's next request holds the other messages and neither the erased text nor the
answer to it.

### What a rebuild loses

Stated plainly, from `features/session_rebuild.feature`:

- **Tool calls, tool results and reasoning of earlier turns.** After a rebuild the model's request holds no `toolResult`
  and none of the tool arguments (a scenario checks `osprey-3`, an argument of an earlier note call). The model remembers
  what it said, not what it did or saw. A bot that relied on a past tool result must be able to call the tool again.
- **Compaction summaries and the system prompt entries.** The next turn regenerates the prompt; a long channel is summarized
  again by the model when the history no longer fits (a model call; measured only in count, not in cost).
- **Per-call cost documents and usage totals** live in the session (`ledger/call-cost.ts`). They are copied into the
  messaging table (`call#` rows in the turn's partition, counters and prices only, no expiry) when each turn's cost is
  recorded, before any erasure drops a session, and once over every existing session by `backfill-record`. The cost API's
  drill-down (`readTurnCalls`) reads the copy, so it still answers after a drop (a scenario shows it). What is lost is the
  session's own usage totals, which nothing reads once the turn's ledger row is written.
- **The provider session identity** (prompt-cache affinity), so the next turn pays a cold cache.
- **The exact shape of the bot's earlier assistant messages** (usage, stop reason, response ids).

What survives: the tool calls as listed on each answer (`activity`), capped as the listing capped them (50 calls, 3000
characters of output each, and 100,000 bytes per row). A scenario shows the channel still lists them after the session
is dropped.

### Summaries and handovers

The prompt text of `docs/MESSAGING.md` ("compacted once and serves every participant") and `docs/DESIGN_CHALLENGES.md`
section 3 describe a channel-level summary. **The code does not have one.** Compaction is pi-durable's, per session, so each
bot summarizes the same channel on its own. I corrected the sentence in `MESSAGING.md`.

Is a channel-level summary needed for handovers (chatticus-3e9444)? Not for correctness. A bot that joins, or a session that
is rebuilt, gets the whole record as text and compaction handles overflow. It is needed for cost and consistency on long
channels: every rebuild or new bot otherwise replays the whole history and pays one summarization of its own, and two bots
disagree about the same past. If it is built, it must be a derived row of the record (`sum#<n>` in the same partition, which
`listMessages` already skips because it reads only `msg#`) carrying `covers_through_seq` and the ids it was made from, so an
erase can invalidate exactly the summaries that absorbed the message and regenerate them from what remains. A summary is one
more erasure target; it must never outlive the message.

## The channel record

**Key.** Partition `<tenant>#channel#<channel>`, sort key `msg#<seq, 10 digits>`. This is the key the Python control plane
used, so the old `msg#` items of migrated channels are already rows of the record, with the same fields. Consequence found
while building this: the migration's day-14 purge (`purge-legacy-items.ts`) deleted exactly those rows, and would now delete
the record. I removed it and its test.

**Fields added:** `origin` (it was being dropped by the codec), `activity` (JSON, the tool calls of a bot answer),
`in_reply_to_seq`, `deleted_at`.

**Writes.** `postMessage` allocates the sequence, then writes the row, then the mailbox items, then admits the turn. The
write is conditional (`attribute_not_exists(sk) OR message_id = :id`), so a retry with the same idempotency key rewrites the
same row and a different message at a taken sequence is refused. A bot answer is written at turn end, after its channel log
line and before its mailbox mirrors; a crash and re-run reuses the sequence and writes the same row.

**Size rule.** A body up to 250,000 bytes sits in its row. A longer one, up to 2,000,000 bytes, is cut into continuation items
of up to 300,000 bytes in the same partition (`msg#<seq>#p0001`, `#p0002`, ...). They sort right after their row, so one
query reads a message with its parts, and they are written before the row, so nobody sees half a message. Erasing deletes them
with the row. A body over 2,000,000 bytes is refused with status 413 and nothing is written. Activity is cut to 100,000 bytes.
A mailbox item for a body over 250,000 bytes holds a pointer (`body_in_record`) and the executor reads the text from the
record. The completion event of a turn carries no body for such a reply, because listeners read the message.

**The overflow is not S3, which is what was asked.** Continuation items are in the same table and partition, so no role needs
a new grant (the owner role already may write `<tenant>#channel#*`), they are erased by the same call, and they are covered by
the same backup window. S3 would have needed a bucket client in six composition roots and new rows for five roles. If bodies
near the cap become common, move them to S3 then; the cap and the item layout are in one codec. A scenario posts 700,000
characters to a channel with no bot and reads it back whole; another sends 400,000 to a bot and checks the model received
it. A bot reply over the row size takes the same path through `putMessage`, but I could not run that end to end: a 300,000
character streamed reply makes the test harness exceed its timeout. The path is covered by the human post and the codec tests.

**Existing channels.** Backfill, not a fallback: `migrate-transcripts backfill-record` merges each channel's sessions and
mailboxes once, with the same merge the list used before, writes the missing rows (activity included), and copies each bot
session's per-call cost records into the messaging table. Rows that already exist (old Python `msg#` items, rows written since
the record began) are left alone. It is idempotent. Order for a deploy: run it, deploy, run it again; the second pass writes
only what the old code committed between the two. Between the deploy and the first pass an unbackfilled channel would list
empty, so the first pass must precede the deploy. A body over the cap is reported (`TOO_LARGE=`) and not written. I did not
run it against any environment.

Backfilled rows have no `in_reply_to_seq`, so an erase cannot find the answers to old messages; it tombstones only the
message itself.

## Roles and infrastructure

A new function, `MessageErasure`, holds the role `erasure` (`infra/lib/control-plane-stack.ts`). It reads a queue
(`MessageErasureJobs`, with a dead-letter queue and an alarm) and an EventBridge rule that runs it once a minute. Its policy
is only what the role access manifest lists for `erasure`, with the table access narrowed by leading key:
- Messaging table: `GetItem Query UpdateItem DeleteItem` on `*#channel#*`; `DeleteItem` on `MB#*`; `GetItem Query PutItem
  DeleteItem` on `*#turn#*`; `Query PutItem DeleteItem` on `ERASURE#pending`; `UpdateItem` on `*#computer#actions`.
- Conversations table: `GetItem BatchGetItem Query BatchWriteItem` on `PI#*`.
- PiSessions bucket: `GetObject DeleteObject DeleteObjectVersion` on `conversations/*`; `ListBucket ListBucketVersions`.
- No access to any secret parameter (nine denial rows in the manifest, as for the other roles).

It cannot write a session, so it cannot rebuild one, and it holds no model key. The front door no longer reads Pi sessions at
all (the listing and the cost drill-down read the messaging table), so its grants on the Conversations table and the bucket
are removed. The turn executor may send to the erasure queue. The manifest's `erasure` rows are checked against what the
scenarios' erasure worker really sends, and against the synthesized policy.

No route sends to the queue yet. The route that lets a person delete a message is the work that remains, and it needs the
front door to be allowed `sqs:SendMessage` on the queue and nothing else.

The hosted runtime that Papyrus deploys (`runtime/site-hosted-chat.ts`) has its own stack and is not covered: Papyrus needs
the same function, queue and role in its chat stack, and a lifecycle rule on its session bucket.

## What makes "the session is a cache" unsound, or at least costly

1. **Cost detail was session-resident.** Fixed by the copy (above).
2. **A turn that starts between the drop and the rebuild** cannot run on an empty session: the owner rebuilds before it takes
   in the mailbox, so the window is closed by construction. The rebuild also gives a bot that joins a channel late the
   history of the record (a scenario shows the first request holds both earlier messages), which settles part of
   chatticus-3e9444.
3. **Departed bots.** There is no remove-bot operation yet (chatticus-3e9444). When one exists it must drop that bot's
   session, or erasure will not know the partition exists.
4. **Recovery of an open turn** reads the session (`PiSubmissionInspector.turnAnswered`). After a drop, an old turn reads as
   unanswered. Only matters if a turn from before the drop is still being recovered, which the "no open turn" rule excludes.
5. **Rebuild cost grows with the channel.** 200 messages: 8 commits written, about 500 DynamoDB and 220 S3 requests for the
   drop and rebuild together, about one second against a local emulator (not a latency to quote). A channel of thousands is
   minutes of writes per bot per erase. Erasing in bulk should batch.
6. **The record becomes a hot, large partition** (one partition per channel). Listing is one query for a channel of 100.
   Pagination exists in the store; the HTTP route does not page.
7. **A model that quotes is not found** (above).

## Before this ships

1. The route that lets a person delete a message, and the front door's right to send to the erasure queue.
2. Run `migrate-transcripts backfill-record` on every environment before the deploy, and `scrub-idempotency --execute` once
   after reading its dry run. Nothing here ran either against any environment.
3. The same function, queue and role in Papyrus's chat stack, and a lifecycle rule on its session bucket.
4. Decide the point-in-time recovery window. 35 days is the default; a shorter one needs `recoveryPeriodInDays` on the tables.
5. A computer action whose command copied the text from an unerased turn, and a turn the erasure cannot name, are not found.

## What the product says

Wording for Chatticus and for Papyrus to show where a person deletes a message. It states only what the design does.

> **Delete message.** The message is removed from the conversation for everyone, right away. Its text is deleted from
> the conversation, from every teammate's working memory of it, and from the records the product keeps of what the
> assistant did while answering it. The assistant's answer to that message is deleted with it.
>
> **What takes longer.** Operational backups and logs age out on their own: backups within 35 days, logs within 30 days, and
> an email that arrived by email within 30 days. Until then they are not readable in the product, only by an operator.
>
> **What deleting cannot undo.**
> - Anything the assistant already sent to people outside this workspace, such as an email.
> - Anything copied elsewhere by a person, or saved by the assistant as a file or a note of its own, or quoted in its answer
>   to a different message.
> - What the AI model provider keeps. Messages the assistant read are sent to the provider to be answered, and the provider
>   keeps requests for a time under its own policy, which this product does not control.
> - A screenshot or a copy on someone's device.

Papyrus can reuse these sentences. Where Papyrus stores its own copy of a person's conversation outside Chatticus, its copy
is its own to delete, and its wording must say so.

## Not verified

- The deployed environments: I read no AWS state. Whether old `msg#` items still exist, whether the day-14 purge ever ran,
  and how many idempotency items hold bodies are all unknown.
- OpenAI's retention terms.
- That DynamoDB TTL lag is "about 48 hours": that is AWS's published figure, not something I measured.
- Behaviour against real S3 versioning: the scenarios use an emulator (moto), whose `DeleteObjects` with `VersionId` I
  rely on.
- The erasure function and its queue were never deployed. Their policy is judged against the manifest by the synthesized
  CDK template and the policy evaluator, not by AWS.
- A reply over 250,000 bytes end to end (see the size rule).
- What a person sees in the app after the message turns into a tombstone: only the field `deleted_at` was added to the API.
