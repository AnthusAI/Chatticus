# Cost accounting spike T2: per-call cost records in the pi-durable session

> **Status:** FINDINGS of Kanbus `chatticus-9e7710` (epic `chatticus-8c857b`), measured against `@earendil-works/pi-durable`
> 1.0.2 and `@earendil-works/pi-ai` as installed at the repo root, on the production `IndexedStorage` (DynamoDB plus S3 on moto).
> `docs/COST_ACCOUNTING.md` (PR 533) is not on `develop` yet, so these findings live here. Fold this file into section 3.2
> and 3.3 of that document when it lands, then delete this file. Nothing here changes production behavior.
>
> Evidence is the vitest `conversation/test/pi-durable-cost-contract.test.ts` (14 tests, all passing). It is kept as a guard
> of the library contract the design relies on: if a pi-durable upgrade changes any of these facts, the test fails
> and the design must be re-read. Items labelled INFERRED were read from library code and not run.

## The question

Can a per-model-call cost record be written into the durable session in the same commit as the response, so cost rides with
the session across handoffs, crashes, retries and takeovers? The design (`COST_ACCOUNTING.md` section 3.2) assumed the
`afterResponse` hook of `GenerationHooks` could write a `defineDoc` document atomically with the response.

## Short answer

No. The `afterResponse` hook cannot join the response commit. It runs before the commit, with a read-only API, so anything it
writes is a separate commit. That is not a blocker: the response commit already contains everything a cost record needs
(the assistant entry carries usage and pi-ai's cost estimate, and pi-durable's own `pi.usage` document is updated in that same
commit). The right design is the fallback in the ticket: derive keyed records from the session at the existing finalize
points. It is idempotent by construction and needs no hook.

## Findings

### 1. Atomicity: the hook is outside the commit

* `GenerationHooks.afterResponse(message, api, context)` is declared to return `void | Promise<void>`, and `HookApi` extends
  `DocumentReader` (reads) plus `taskId`, `conversationId` and `memo`. There is no `tx` and no write method
  (`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts`).
* In `dist/harness/generation.js`, `classify()` calls `runtime.hooks.each("afterResponse", ...)` and only afterwards opens the
  commit that appends the assistant entry (`appendAssistant`, which also calls `recordUsage` on `pi.usage`). The hook is
  therefore strictly before the response commit.
* The object handed to the hook is the scheduler runtime, which at runtime does have a `commit` function that `HookApi` does not
  declare. The experiment calls it (the test casts the type away). The write works, but it is its own commit, and it relies
  on an undocumented, untyped surface. Commit log from the test "afterResponse has no transaction":
  the commit holding `doc:spike.cost-record#response-<id>` has a lower sequence than the commit holding
  `entry:pi.assistant`, and no commit contains both.
* What is atomic with the response: the assistant entry and `doc:pi.usage` appear in the same commit (test "pi.usage rides in the
  same commit as the assistant entry"). Failed responses go through the same `appendAssistant`, so they are entries and in
  `pi.usage` too. The cost-bearing record is the entry itself.
* Process death between the hook commit and the response commit (test "a death between the hook commit and the response
  commit", a storage wrapper that refuses the commit containing the assistant entry and every commit after it): the keyed record
  survives, the assistant entry does not exist, and `pi.usage` is still empty. So a hook-written record is not "with the
  response"; it can exist for a response the session never learned about.

### 2. Idempotency under retry and takeover

* After that death, a new owner with a newer fence resumes the same submission. The generation task is still in its request
  phase, so it asks the model again. This is a second paid call, with a second response and a second hook call
  (test "after the death a new fence re-requests the model"). With distinct provider response ids the hook records two
  keyed documents, which is correct (two calls were paid for, the first answer was lost). With the same response id (what a
  re-poll of one deferred response would show) the keyed write is a no-op and there is one record. The final session holds one
  assistant entry and `pi.usage` counts only that one call: the first call exists only in the hook record.
* A stale owner cannot write after a takeover: a commit from the first owner after the second claimed the partition is rejected
  with `OwnershipLost`, and no record appears (test "a stale owner cannot write a record after a takeover").
* The fallback is idempotent without any hook: `deriveCostRecordsFromEntries` (in the test) scans assistant entries and writes a
  family document keyed `entry-<entryId>`, skipping filled ones, in one commit. Run on the first owner, then twice on the
  second owner with a new fence: 2 written, then 0, then 0 (test "the fallback derives keyed records from entries"). A crash after
  the response commit and before any record write loses nothing, because the new owner derives the same records from the
  entries (test "a crash after the response commit").
* Residual loss window, for any session-side design: a crash after the provider answered and before the response commit (or,
  for the hook design, before the hook). The call was paid and the session never sees it. Only an observation made outside the
  session (the gateway, ticket T5) covers that.

### 3. Readable by key, and carried with the session

* A `defineDocFamily` keyed document (scope conversation, history latest) is read with `session.snapshot(token, conversationId,
  key, context)` and listed with `storage.scanDocuments({ scope, at: "current", kind })`, from a reader built with
  `createSession(await IndexedStorage.open({ ...no fence }))`. No Harness is opened, no task runs, no entries are replayed
  (test "readable by key and by listing through a reader session that replays nothing"). `pi.usage` is read the same way.
* A different owner opening the partition sees the same records with no rebuild (test "a session opened by a different owner").
* Forks (matters for T6): with `fork: "initial"` a forked conversation starts with no records, and with `fork: "current"` it copies all
  of the parent's. A cost document must use `fork: "initial"`, otherwise summing across conversations counts the parent's
  history twice. `pi.usage` already uses `fork: "initial"`, so a fork's `pi.usage` is empty (test "a fork starts empty").
  Note that `storage.scanEntries({ conversationId: fork })` returns the parent's entries inherited by the fork, so derivation
  must filter `entry.conversationId === conversationId`.
* Sub-agents (matters for T6): a child created in a tool with `ownership: { kind: "task", taskId }` is found by
  `scanConversations({ ownerTaskId })` (index `CT#`), by `scanConversations({ ownerConversationId })` (index `CC#`), and by
  `scanConversations({})` (all conversations of the partition). The child has its own `pi.usage` and its own cost documents, and
  `harness.usage()` sums root and child (test "task-owned child conversations enumerate"). That sum is a ready cross-check
  for a turn total.
* Scope note: a session partition is per bot and channel (`PI#{tenant}#{bot}#{channel}`). Records ride with that
  partition. A channel with several bots spans several partitions, so a channel total cannot come from the session alone.

### 4. Is usage plus pi-ai's estimate enough to price with our own book?

Yes, with no new hook. Each assistant entry stores `usage.input` (uncached, because the OpenAI adapter subtracts cached and cache
write tokens from `input_tokens`), `cacheRead`, `cacheWrite`, `output` (reasoning is a subset of output, with `reasoning` carried
separately), `totalTokens`, and `cost` from pi-ai's catalog, plus `provider`, `model`, `responseModel`, `responseId` and
`stopReason`. The context size for tier selection is `input + cacheRead + cacheWrite`. The test recomputes dollars from a
separate price book (base rates plus a tier above 272,000 context tokens) and matches the stored estimate to 12 decimal places
for a normal and a long-context call. So the cost record can be a pure function of (stored usage, our price book): store the
raw counters, the price book id and our computed dollars, and keep pi-ai's `cost.total` only as the cross-check the plan wants.

What the stored response does not carry:

* **Compaction summarization.** `CompactionTask` calls the model and records the usage into `pi.usage`
  (`dist/harness/compaction.js`, `recordUsage`) but appends no assistant entry, and compaction has no `afterResponse` hook. In the test the
  summary call (900 input, 60 output) is in `harness.usage()` and absent from the entries, and the hook was called only for the two
  generation responses. It can only be recovered as `pi.usage` totals minus the sum over entries, per conversation and model.
* **Errored responses with usage** are entries and in `pi.usage` (test "an errored response with usage"). **Aborted partial
  responses** are converted into an aborted assistant entry by `convertPartial` (INFERRED from the code, not run); an attempt that
  produced no partial has no usage anywhere.
* **Service tier pricing** (`applyServiceTierPricing`, flex or priority multipliers in the OpenAI adapter) changes
  the stored `cost` but the message carries no service tier field, so our own book cannot reproduce it from the entry alone
  (INFERRED, not run). Chatticus does not request a service tier today; if it ever does, record the tier alongside the call.
* `pi.usage` itself is bucketed by `provider/model` per conversation, not per call, so it is a total to reconcile against, not a
  per-call source.

## Recommendation

**Do not build on the `afterResponse` hook. Use the fallback: idempotent keyed derivation at the existing finalize points.**

1. The cost record is derived from the assistant entries of a conversation, keyed `entry-<entryId>` (family document, scope
   conversation, history latest, `fork: "initial"`), written in one commit per derivation, skipping filled keys. It is
   atomic with nothing extra to prove, because its source (the entry and `pi.usage`) is already in the response commit.
2. Derive at conclude, fail, yield and park (the safety-net points already in section 3.3), and on takeover before the new owner's
   first model call. Each run is a no-op for records already written, so repeat, retry and takeover are free.
3. Price at record time from the versioned book and store `priceBookId`, tier, raw counters and our dollars on the record. Keep pi-ai's
   estimate as a field for the cross-check.
4. Account for compaction as a per-conversation remainder: `pi.usage` total minus the sum of entry usage, recomputed (not
   accumulated) at the same points, written under a key such as `compaction-remainder-<conversationId>-<turnId>`.
5. Keep the hook out of the design. It adds only one thing the derivation does not: a record for a response whose commit then
   failed. That window is narrow (hook to commit) and is already the job of the gateway observation (T5), which also covers the
   wider window before the hook. If the owner ever wants the hook as an optimisation, it must use the undocumented runtime `commit`
   and a key derived from `responseId`, and the derivation must still run, so it buys nothing.
6. Channel total (ticket item 4, a design decision rather than a measurement): sessions are per bot and channel, so the channel
   total belongs in the messaging table. Use a sibling item `pk = {tenant}#cost#channel#{channelId}` updated in the same transaction as the
   turn index item (idempotent by turn id), not a GSI: one household, a handful of channels, and a GSI adds an index to the table
   for a read that a single key serves.

## Effect on the plan and tickets

* `COST_ACCOUNTING.md` section 3.2: replace the ASSUMPTION about `afterResponse` with "resolved, no; fallback adopted". Section 3.3: strike
  "each `afterResponse` (preferred)" and keep conclude, fail, yield, park, plus takeover.
* **T4** (call records in the session): implement `deriveCostRecordsFromEntries` as the single writer; family document
  `chatticus.cost`, key `entry-<entryId>`, `fork: "initial"`, entry filter on `conversationId`. No hook, no use of the runtime commit. Retire delta
  counters as planned. Add the takeover case (derive before the first model call of a new owner).
* **T5** (complete metering): compaction comes from the `pi.usage` remainder, not from a hook. Aborted and errored responses with usage are
  already entries. Calls that never reached a commit are only reachable through the gateway observation, which therefore stays in scope as the
  only cover for that window, and reconciliation should treat a small positive observed-minus-session gap as expected.
* **T6** (sub-agent and fork accounting): enumerate with `scanConversations({})` per partition, `{ ownerTaskId }` for one task and
  `{ ownerConversationId }` for the children of a conversation; `fork: "initial"` on the cost document; filter inherited entries on a fork; use
  `harness.usage()` (which sums children) as the cross-check for the turn total.
* **T3** (price book): add a service tier field to the record if a service tier is ever requested.
