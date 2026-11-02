# Erasing a deleted message

Status: design, with a proving spike. Nothing here is reachable from a route yet. Tickets: chatticus-c02220 (this),
chatticus-e4f1f2 (the channel record). Ryan's decision (2026-11-02): deletion is real, so no privacy or retention problem is
waiting later.

The design below is not yet decided by Ryan. It is built so that choosing it, or not, is cheap to change: the channel record
is useful on its own, and the erasure code is five small modules that no route calls.

## What is built

| Piece | Where |
| --- | --- |
| The channel record: one DynamoDB row per message, `msg#<seq>` in the channel's partition, written by `postMessage` and, at turn end, by `commitFinalAnswer` | `domain/messages.ts`, `turn/finalize.ts`, `store/codecs/channel.ts` |
| Tombstone: `tombstoneMessage` empties the body, activity and origin and sets `deleted_at` | `store/dynamo-messaging-store.ts` |
| Drop a session: every DynamoDB item of `PI#<tenant>#<bot>#<channel>` except `OWNER`, every S3 object version under `conversations/<storage>/` | `pi/session-drop.ts` |
| Rebuild a session from the record | `pi/session-rebuild.ts` |
| Erase one message, and finish an erasure that waited on an open turn | `domain/message-erasure.ts` |
| Backfill existing channels into the record | `migration/backfill-record.ts`, `migrate-transcripts backfill-record` |
| Proof | `features/channel_message_record.feature`, `features/message_erasure.feature`, `features/session_rebuild.feature` |

## Where a message's text can live

Each row says how it was established. "Verified" means a scenario scans the store for the text (the step
`the text ... is held by`), so the claim does not rest on reading code.

| Store | Holds the text? | How established | At erase |
| --- | --- | --- | --- |
| Channel record row (`msg#`) | body, origin assertion; tool arguments and outputs in `activity` of bot answers | verified | tombstoned at once |
| Bot answers to the turn the message started (`in_reply_to_seq`) | the answer, and its activity, are derived from the message | verified | tombstoned at once with it |
| Mailbox items (`MB#<tenant>#<bot>#<channel>`) | body, until the bot reads it | verified | deleted at once |
| Pi session, S3 commit objects | every entry (user and assistant text, tool calls and results, compaction summaries, submissions, documents) | verified: the text is in the commit objects and in no DynamoDB item of the session | dropped at once, every version |
| Pi session snapshots (`conversations/<storage>/snapshots/`) | packs of commit objects | read from `storage/snapshot-object.ts`; same prefix as the commits | dropped at once with the prefix |
| Pi session, DynamoDB items (`PI#...`) | index items (ids, positions, pointers) | verified: no item holds the text | dropped at once; `OWNER` kept, it holds only the fence |
| Sub-agent conversations | pi-durable keeps a task's child conversations in the same storage (README, "Abort and Subagents"), so they live in the session partition and objects. There is no sub-agent tool yet (chatticus-378eed) | read from the README | gone with the session |
| Compaction summaries | entries of the session (`pi.compaction`), so in the commit objects | README, "Compaction": older entries stay in storage | gone with the session. A summary is never kept across a drop; the rebuilt session is summarized again from the remaining text |
| Post idempotency item (`idem#` in the messaging table) | **the whole message, forever.** It stored the body, and has no expiry. The embedded chat client sends an `Idempotency-Key` on every post (`chat/client/admission.ts:26`) | verified by a scenario before the fix | **fixed in this change**: the item keeps only the channel, sequence, message id and turn id, and a replay reads the message from the record. Items written before this change still hold bodies and must be scrubbed once (see "Before this ships") |
| Message cache (`MessageBodyCache`) | parsed commit objects, in the memory of each front door instance | `pi/message-cache.ts` | the dropping process evicts its own entries; other instances keep theirs until they recycle. Nothing asks for those keys again, because new commit objects carry a higher fence. Expires with the instance; cannot be reached |
| Turn events (`evt#` rows; streamed tokens, tool arguments and outputs, the completed body) | the reply, and tool text | `store/turn-events.ts`; `TURN_EVENT_TTL_SECONDS` is 24 hours | **expires**: 24 hours, plus DynamoDB's TTL lag (AWS documents deletion within about 48 hours of expiry). Explicit deletion needs a turn lookup by channel and prompt, which does not exist |
| Turn record, ledger rows, per-call cost records | ids and counters only; no text | `ledger/`, `domain/turns.ts`: no body field | nothing to erase |
| Computer action items (`action-store`) | tool `arguments` and `result` (for example the body of a `send`), with `turn_id` and `channel_id`, and no expiry | `store/codecs/action.ts` | not reached. Linked to a turn, not to a message. Needs a sweep by turn, which is not built |
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
- every bot session on the channel that has no open turn: its DynamoDB items except `OWNER`, and every S3 object version and
  delete marker under its prefix, snapshots included; and then the session is rebuilt from the record without the text
- the post idempotency copy (new items hold no text)

**Waits for an open turn** (the tombstone and the mailbox deletion happen at once; the session stays until the turn ends):
a pending marker `ERASURE#<tenant>#<channel>` is written. `completePendingErasures` repeats the erasure, which also
tombstones the answer the finished turn committed. Until then the bot's session still holds the text and the running turn
may use it. Nothing calls `completePendingErasures` yet; it belongs where a turn closes (`finalize.ts`) and in a sweeper.
If the open turn's prompt was the erased message, the executor finds its mailbox item gone and may fail the turn; I did not
look into what the user sees then.

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
- **Per-call cost documents and usage totals**, which live in the session (`ledger/call-cost.ts`). The cost API's per-call
  detail (`readTurnCalls`, `domain/costs.ts:595`) reads them from the session, so after a drop it returns nothing for old
  turns (a scenario shows this). The ledger rows in the messaging table are unaffected. To keep the detail, copy the call
  records to the ledger table before any drop. Not built.
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

**Size rule.** A body over 250,000 bytes is refused (`MessageBodyTooLargeError`); activity is cut to 100,000 bytes. The
item limit is 400 KB. The recommended overflow, not built, is an S3 object under the PiSessions bucket keyed by message id,
referenced from the row, deleted with the row on erasure (the same drop-by-version code). I stopped at the guard because it
changes where a bot reply is stored and I did not want to decide that alone. **A bot reply over 250,000 bytes now fails
`commitFinalAnswer`.** That is possible with a long model output, and an inbound email is cut at 100,000 *characters*, which is up to
400,000 bytes of emoji. A scenario (`email_inbound_parsing.feature`, "A long body is cut at 100 KB") hit the first limit I
chose at 100,000 bytes, which is why it is 250,000 now. Do not ship without the overflow or a decision to truncate by bytes.

**Existing channels.** Backfill, not a fallback: `migrate-transcripts backfill-record` merges each channel's sessions and
mailboxes once, with the same merge the list used before, and writes the missing rows, activity included. Rows that already
exist (old Python `msg#` items, rows written since the record began) are left alone. It is idempotent. Order for a deploy:
run it, deploy, run it again; the second pass writes only what the old code committed between the two. There is a window
between deploy and the first pass in which an unbackfilled channel lists empty, so the first pass must precede the deploy.
Bodies over the limit are reported (`TOO_LARGE=`) and not written. I did not run it against any environment.

Backfilled rows have no `in_reply_to_seq`, so an erase cannot find the answers to old messages; it tombstones only the
message itself.

## Roles and infrastructure this needs

The scenarios run the erasure with clients outside the front door's recorded role, because the role access manifest rejected
the first attempt: no role may today delete Pi session objects, list their versions, or batch-delete session items. A new
role, assumed by one function that reads an erasure queue, needs: `dynamodb:Query` and `BatchWriteItem` on the Conversations
table for `PI#` partitions; `s3:ListBucketVersions` and `s3:DeleteObjectVersion` on the PiSessions bucket; the Messaging
table (`UpdateItem` on `msg#`, `DeleteItem` on `MB#`, put and delete on `ERASURE#`). The front door only enqueues.

The rebuild needs the owner's session write rights (commit objects, fenced transactions). Cleaner: the erasure role drops, and
the **turn owner rebuilds lazily** when it opens a session that is missing or empty and the record has history. That is a
change in `turn/executor.ts`, which another change is editing; I did not touch it. The spike rebuilds eagerly, in the erasure
call, which is simpler to prove and wrong to ship: it needs the owner rights in the erasure role.

## What makes "the session is a cache" unsound, or at least costly

1. **Cost detail is session-resident** (above). Either copy it out first or accept the loss.
2. **A turn that starts between the drop and the rebuild** runs against an empty session. The spike does not gate this. Needs
   an `erasing` flag on the channel that admission respects, or the lazy rebuild above, which closes the gap by construction.
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

1. Decide the overflow for bodies over 250,000 bytes.
2. Scrub the old post idempotency items (they still hold bodies): a one-off scan that removes `body` and `origin` from
   completed items. Keys are hashed, so only a scan finds them.
3. Run `backfill-record` on every environment, before the deploy.
4. The erasure role and queue; the lazy rebuild in the executor; the `erasing` gate.
5. Add the lifecycle rule to Papyrus's session bucket.
6. Decide the PITR window. 35 days is the default; a shorter one needs `recoveryPeriodInDays` on the tables.
7. Turn events and computer actions: a lookup by channel so they can be deleted instead of expiring.

## Not verified

- The deployed environments: I read no AWS state. Whether old `msg#` items still exist, whether the day-14 purge ever ran,
  and how many idempotency items hold bodies are all unknown.
- OpenAI's retention terms.
- That DynamoDB TTL lag is "about 48 hours": that is AWS's published figure, not something I measured.
- Behaviour against real S3 versioning: the scenarios use an emulator (moto), whose `DeleteObjects` with `VersionId` I
  rely on.
- What the user sees when an erased message was the prompt of a running turn.
