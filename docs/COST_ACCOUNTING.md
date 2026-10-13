# Cost accounting (audit and plan)

> **Status:** AUDIT of `origin/develop` at b902f5d3 (2026-10-13) plus a PROPOSED contract. Sections 1 and 2 describe code as it is;
> every claim carries a file or function reference. Section 3 is the proposal, written in the spirit of
> [Live files protocol](LIVE_FILES_PROTOCOL.md) but shorter. Anything not verified by reading code or running it is
> labelled INFERRED or ASSUMPTION. No production code changed in this task. The Kanbus epic and tickets that carry the
> work are listed in section 6.

## 0. The owner's vision, and the short answer

The vision: full transparency over the **actual direct costs** (AI API tokens priced from published vendor prices) per session,
per bot, per message or turn, per tool call or loop where possible, and per sub-agent, so people can compare ways of working
and see where money goes. The cost data lives **with the durable pi-durable session**, survives handoffs between workers,
computers and restarts, and stays at parity with durability features as they are built.

The owner's suspicion was "it probably is stored, but this needs checking". Checked result:

| Owner expectation | Today | Evidence |
| --- | --- | --- |
| Model token usage is recorded per turn | TRUE | `recordTurnSpend` in `conversation/src/turn/finalize.ts`; ledger row in `conversation/src/ledger/vendor-ledger.ts` |
| Dollars come from published vendor prices | PARTLY TRUE | A frozen price table (`vendor-prices.ts`) sourced from LiteLLM's catalog, a third-party list, not OpenAI's page. Cached input and the long-context tier are not modelled |
| Cost is recorded the same way on a Lambda worker and on a computer owner | FALSE | The computer owner is metered twice by two writers (section 2, finding F1). Lambda is metered once, from the session |
| Cost survives crash, retry and takeover without double counting or loss | TRUE on the Lambda path, FALSE on the computer-owner path, and calls whose answer never arrived are lost | `recordTurnSpendOnce` fence (Lambda); F1 (owner); F5 (lost calls) |
| Cost is stored together with the durable session | FALSE for dollars, TRUE for raw tokens | The dollar ledger is a separate messaging-table row keyed by turn. The session itself does persist per-response tokens and pi-ai's own cost estimate (`message.usage`, and the `pi.usage` document), but nothing in Chatticus reads or exposes them |
| Cost per session / channel | FALSE | No row, route or screen sums by channel. The ledger row holds only tenant and turn |
| Cost per bot | FALSE | Same: ledger row has no `bot_id` |
| Cost per message / turn | PARTLY TRUE | Per turn exists in storage (one row per turn). No API route and no screen shows it |
| Cost per tool call or loop | FALSE | One row per turn; no per-model-call or per-round data is kept in the ledger |
| Cost per sub-agent | FALSE | Chatticus has no sub-agent tool yet. When it does, `measureTurnUsage` reads only the root conversation, so a child's spend would be missed |
| Cost visible to users in the web app | FALSE | `web/` shows only the monthly AWS spend ceiling and the computer-paused notice. No model cost anywhere |
| Cost exposed over the HTTP API | FALSE | The only spend routes are `PATCH /orgs/{t}/monthly-aws-spend-ceiling` and ceiling fields on `/me` |
| Every model call is metered | MOSTLY TRUE | Turn calls (both owners), the voice understanding call. Compaction summaries, aborted or failed attempts, and cached or reasoning breakdowns are not (F5, F6). No title-generation, routine or other model call exists |
| Per-organization rollup | PARTLY TRUE | The daily rollup sums ledger dollars per organization per day (`conversation/src/budget/runner.ts`), but only into a budget alert and the computer-work meter; there is no readable report |
| Per-user rollup | FALSE | Ledger carries no user id |

**Plain version for copy writers:** Chatticus records model token spend per turn today and uses it for operator budget alerts.
It does not yet show anyone a cost, does not break cost down by bot, session, message, tool call or sub-agent, and the cost record
is not part of the durable session. Do not claim any of those until the tickets in section 6 land.

## 1. What exists today

### 1.1 Recording path

```
                 Lambda owner (turn-executor)                       Computer owner (container)
                 models: pi-ai OpenAI, real key                     models: pi-ai OpenAI -> model gateway (Front Door)
                                |                                                  |
   model loop runs inside the pi-durable session            each model HTTP call -> modelGatewayResponsesHandler
   (assistant entries carry message.usage)                   -> recordVendorSpend  (ADD tokens + dollars, per call)
                                |                                                  |
              conclude()/fail(): recordTurnSpend               same executeTurn core: conclude()/fail(): recordTurnSpend
              -> measureTurnUsage walks root entries           -> measureTurnUsage walks root entries again
              -> recordTurnSpendOnce (transaction, fenced)     -> recordTurnSpendOnce adds the whole session total (F1)
                                \                                      /
                                 messaging table row  {tenant}#vendor_ledger / turn#{turnId}
                                              |
                       daily rollup Lambda (budget/runner.ts) sums cost_usd per org per day -> budget_rollup row, alerts
```

### 1.2 What is stored, and where

| Store | Key shape | Content | Written by | TTL |
| --- | --- | --- | --- | --- |
| Messaging table, vendor ledger row | `pk = {tenant}#vendor_ledger`, `sk = turn#{turnId}` (`vendorLedgerKey` in `conversation/src/budget/budget-store.ts`) | `tenant_id`, `turn_id`, `vendor`, `model`, `input_tokens`, `output_tokens`, `billed_via` (`vendor` or `aws`), frozen `input_price_per_million_usd` / `output_price_per_million_usd`, `cost_usd` (8 decimal places, half-even), `recorded_at` | `recordVendorSpend`, `recordTurnSpendOnce` (`ledger/vendor-ledger.ts`) | none written (the table's TTL attribute is `expires_at`; ledger rows set none) |
| Voice ledger row | same `pk`, `sk = turn#voice:{uuid}` | one row per spoken line, same fields | `postVoiceMessage` in `conversation/src/domain/voice-messages.ts` | none |
| Turn record counters | `pk = {tenant}#turn#{turnId}`, `sk = meta`: `ledger_input_recorded`, `ledger_output_recorded` | how many tokens of the turn the ledger already holds, advanced in the same transaction as the ledger write under the attempt fence | `recordTurnSpendOnce` | none written for meta; events expire after 24 hours (`TURN_EVENT_TTL_SECONDS`) |
| Daily rollup | `budgetRollupKey(tenant, environment, date)` | `vendor_cost_usd`, `aws_cost_usd`, `combined_report_usd`, `ce_status`, alert events | `budget/runner.ts` | none |
| pi-durable session, entries | Conversations table partition `PI#{tenant}#{bot}#{channel}` (`IndexedStorage`, `storage/indexed-storage.ts`), record `R#{id}` of type `entry`; large bodies in the sessions S3 bucket | each assistant entry carries `message.usage`: `input`, `output`, `cacheRead`, `cacheWrite`, optional `reasoning`, `totalTokens`, and pi-ai's own `cost` (`input`, `output`, `cacheRead`, `cacheWrite`, `total`) from its model catalog | pi-durable | none |
| pi-durable session, `pi.usage` document | same partition, record of type `document`, scope = (conversation, `pi.usage`) | per conversation totals bucketed by `provider/model` and by tool name; per pi-durable's README "failed and aborted attempts count too" and compaction summarization counts | pi-durable (`UsageDoc`, `harness.usage()`) | none |

Key observation: the **session already stores usage per model response and a running total per conversation**, and pi-durable's
README documents that totals include failed, aborted and compaction attempts. Chatticus does not read `pi.usage` or
`harness.usage()` anywhere (grep of `conversation/src`: no match). It re-derives tokens by walking assistant entries from the turn's
prompt entry (`measureTurnUsage`), which skips compaction summarization (those attempts have no entries per pi-durable's `usage.d.ts`
comment) and any call that never produced an entry.

### 1.3 Pricing

`conversation/src/ledger/vendor-prices.ts`: `OPENAI_MODEL_PRICES` has `gpt-6-luna` (0.10 in / 0.50 out), `gpt-5-nano` (0.05 / 0.40), `gpt-5-mini`
(0.25 / 2.00) per million tokens, "fetched 2026-10-11" from LiteLLM. `VendorPriceBook.lookup` returns null for an unknown model; the row is
then written with tokens and no dollars. The first call of a turn **freezes** the price onto the row (`insertItem`); later additions use the frozen
rates (`accumulateUpdate`). For comparison, pi-ai's own catalog (`node_modules/@earendil-works/pi-ai/dist/providers/data/openai.json`) lists
`gpt-6-luna` with input 0.1, output 0.5, cacheRead 0.01, cacheWrite 0.125 and a tier above 272000 input tokens (input 0.2, output 0.75,
cacheRead 0.02, cacheWrite 0.25). Chatticus ignores the cache and tier fields.

### 1.4 The model gateway (`conversation/src/gateway/model-gateway.ts`)

* Admission: signed per-owner session token bound to tenant, turn, bot and owner; refuses a non-active turn or the wrong owner; model must be in
  `OPENAI_MODEL_PRICES`; `store` and `background` refused; function tools only; body at most 2 MiB; `max_output_tokens` clamped to
  `GATEWAY_MAXIMUM_OUTPUT_TOKENS` (32768).
* Recording: `spendRecorderFor` calls `recordVendorSpend` with `usage.input_tokens` and `usage.output_tokens` read from the final `response.completed` or
  `response.incomplete` event (`usageFromEvent`) or the JSON body (`usageFrom`). Cached and reasoning detail fields are not read.
* Interruption: if the client drops or the upstream breaks first, `meteredStream` records one estimate (`estimated_after_interruption`): input =
  request body bytes / 4, output = characters of text `delta` events seen so far / 4. Hidden reasoning tokens are therefore not estimated.
* Non-OK upstream: nothing recorded (`upstream_failed`), and the vendor's error text is withheld.
* No per-call organization or per-turn dollar ceiling (`docs/PI_SESSION_HANDOFF.md`, "Gateway controls"). The only ceiling is the monthly **AWS** spend ceiling.

### 1.5 Visibility

| Granularity | Recorded | API | Web |
| --- | --- | --- | --- |
| Model call | Session entries hold tokens and pi-ai cost (not read). Gateway sees each call but sums it away | none | none |
| Round or loop within a turn | no | none | none |
| Tool call | no (tool events exist, with no cost) | none | none |
| Turn | yes, one ledger row, tokens plus dollars | none | none |
| Message | indirect: a turn has `promptMessageSeq` and `messageSeq`, ledger row has `turn_id`; nothing joins them | none | none |
| Session or channel | no | none | none |
| Bot | no (`bot_id` is on the turn record only) | none | none |
| Member | no (`promptAuthorId` is on the turn record only) | none | none |
| Sub-agent | not applicable yet; would be missed (F4) | none | none |
| Voice line | yes, `voice:{uuid}` row, tenant only | none | none |
| Organization per day | yes, `vendor_cost_usd` in the daily rollup | none (feeds `computer_work_paused` on `/me`) | paused notice only |
| Organization AWS spend | Cost Explorer read by the rollup | ceiling field on `/me` | `SpendCeilingForm`, `ComputerPausedNotice` |

Routes: `grep` of `conversation/src/http` finds no route returning tokens or model dollars. `web/` greps for `vendor`, `ledger`, `cost_usd`, `input_tokens` find nothing in
product code; "spend" appears only for the AWS ceiling (`web/lib/spend-ceiling.ts`, `web/components/SpendCeilingForm.tsx`).

### 1.6 Other model calls

Searched `conversation/src` for `completeSimple`, `streamSimple`, `.stream(`, `createModels()`, `api.openai.com`. The only live model callers are:
the bot turn (pi-durable harness through `createOpenAiModels` or `createGatewayModels`), the voice understanding call
(`conversation/src/voice/understanding.ts`, `gpt-5-nano`, minimal reasoning), and pi-durable's own compaction. There is no title generator, no routine model call, and no
sub-agent tool (the `task` tool in `pi/task-tool.ts` is a household to-do tool, not a delegate). `migration/copy.ts` calls `createModels()` only to open storage.

## 2. Gaps and risks, ranked

Severity: **A** wrong numbers now or silent loss, **B** blocks the vision, **C** quality.

### A: correctness

**F1 (A, by code reading, not reproduced): a turn run by the computer owner is counted twice.**
`takeOverTurn` (`turn/computer-owner.ts`) calls the same `executeTurn`, whose `conclude()` and `fail()` call `recordTurnSpend`. On the container the
models also go through the gateway, which already `ADD`ed each call to the same ledger row (`recordVendorSpend`). `recordTurnSpendOnce` computes its delta
from `ledger_input_recorded`, a counter only that function advances, so it starts at 0 and adds the **whole** session total again, at the row's frozen
price. Net: tokens and dollars of every container-run call are doubled. `docs/PI_SESSION_HANDOFF.md` records "spend recorded through the gateway" as a live smoke and no
scenario covers both writers on one turn (`features/model_gateway.feature`, `features/vendor_ledger.feature` each cover one writer). Also, the container's ledger dependency uses an
empty `new VendorPriceBook()` (`computer/host/src/owner-deps.ts:76`), so if finalize ever inserted first it would write tokens with null dollars. A turn that starts on Lambda, parks and finishes on the
computer double counts only its container part. Ticket T1 writes the failing scenario first.

**F2 (A): unpriced model means silent zero.** `costUsdFromTokens` returns null without a price, and the rollup skips null (`budget/runner.ts`, `row.costUsd === null`). The gateway refuses unpriced
models, but the Lambda owner does not: switching `DEFAULT_TURN_MODEL` (`turn/openai-models.ts`) to a model absent from `OPENAI_MODEL_PRICES` records tokens and shows $0 in every meter. There is no alarm.

**F3 (A): one model and one frozen price per turn.** `measureTurnUsage` takes `provider` and `model` from the **first** assistant message (its doc comment says newest), and the ledger row holds one `model`. A turn that switches
model mid-way is priced entirely at the first model's rates. Not live today (single model), but the row shape cannot express it.

**F4 (A, future): sub-agents and forks would be uncounted.** pi-durable supports task-owned child conversations (README "Abort and Subagents") and forks, each with its own `pi.usage`.
`measureTurnUsage` calls `root.entries(...)` only. The first sub-agent extension would spend tokens that no ledger row contains. This is the central parity risk the owner anticipates.

**F5 (A): calls with no entry are lost.** (a) Lambda owner: an attempt that dies, times out or yields while a model call is in flight leaves no assistant entry; the call is billed by the vendor and recorded nowhere
(the gateway path at least records an estimate). (b) Compaction summarization calls have no entries (pi-durable `usage.d.ts`). (c) Aborted or errored responses may carry usage that the entry walk does not see
(INFERRED; pi-durable README says they count in `pi.usage`, whose totals Chatticus does not read). (d) Gateway: a ledger write failure after the vendor answered fails the response and loses the spend (`recordOnce` awaits before closing the stream).
(e) Spend is recorded only at `conclude()` and `fail()`. A turn that is `yielded`, `parked` or `lost` writes nothing at that moment; its tokens are picked up later by the next attempt's cumulative walk, so they are not lost unless the turn never concludes.

**F6 (B): token fidelity.** The ledger has two counters. Cached input is summed into input at the full input rate (finalize adds `input + cacheRead + cacheWrite`; the gateway reads `input_tokens`), a documented overestimate: for `gpt-6-luna` cached input is
0.01 versus 0.10 per million. The long-context tier (input above 272000 tokens, per request) cannot be applied after aggregation. Cache writes (0.125) are not priced. Reasoning tokens are inside `output`
(correctly billed as output) but cannot be shown separately. Voice understanding drops `cacheRead` (`message.usage.input` only).

**F7 (C): rollup and attribution mechanics.** `recorded_at` is the first call's time, so a long turn is attributed wholly to its first day. `listVendorLedgerRowsForTenant` queries the whole tenant partition on every rollup run with no month key, and ledger rows never expire (fine at household scale, an O(all history) read per run).
Voice failure to record is swallowed with a `console.warn` (`domain/voice-messages.ts`).

### B: vision gaps

* **G1** No dimensions: the ledger row has no `bot_id`, `channel_id`, `user_id` or `conversation_id`. Per-bot, per-channel and per-member views would require joining to turn records.
* **G2** No per-call or per-round granularity, so per tool call, per loop and "where money goes inside a turn" are impossible.
* **G3** The cost record is not in the session. A session moved or restored elsewhere (copy of the `PI#...` partition and its S3 objects) carries tokens and pi-ai estimates but not Chatticus's priced, attributed record. There is no environment-to-environment mover in the repo today (the migration CLI moves legacy transcripts into Pi), so portability is by design intent only.
* **G4** No API, no web view, no export, no comparison.
* **G5** No price provenance: no price book version id or source on a row, no verification against OpenAI's page, no scheduled check; `docs/BUDGETS.md` itself says "re-check it when a price matters".
* **G6** No parity guard: nothing fails when a new conversation kind, tool or model call is added without cost accounting.
* **G7** No per-turn or per-session dollar ceiling in the gateway (a budget feature, listed so it is not mistaken for cost transparency).

### Existing Kanbus tickets (`KANBUS_NO_DAEMON=1 kbs list`, filtered by cost, spend, ledger, price, usage)

Open and relevant: `chatticus-12ba7f` (cached input and long-context tier not modelled; this plan's T3 supersedes it), `chatticus-9563cb` (a member sees the organization **AWS** spend; different meter), `chatticus-9860a5` (published AWS cost of one computer), `chatticus-26f253` and `chatticus-9ac621` (rollup not deployed, AWS meter false zero; these affect the combined meter, not per-turn accounting), `chatticus-d706d7` (cost allocation tags).
Closed and foundational: `chatticus-89adc0` (ledger of vendor spend per turn), `chatticus-08851f` (TS-21 spend recording from Pi usage), `chatticus-052202` (spend ceiling), `chatticus-2e3e94` (budget epic, still open). `kbs search` is not a subcommand in the installed `kbs`; `kbs list` with a filter was used instead. No existing ticket covers per-bot, per-session, API or web cost visibility, or the computer-owner double count.

## 3. Target design (PROPOSED contract)

### 3.1 Principles

1. **The session is the source of truth for tokens.** Every priced figure must be derivable from records that live in, and move with, the pi-durable session.
2. **Idempotent by key, not by counters.** A cost record is identified by (conversation id, entry id or call id). Writing it twice is a no-op. This removes F1, the attempt-fenced delta counters and the dual-writer problem structurally.
3. **One writer for dollars.** The gateway stops adding to the ledger. It remains the enforcement point (admission, clamps, later ceilings) and logs an *observation* used only for reconciliation (3.6).
4. **Price at record time from a versioned price book, and keep the version on the record** so history is reproducible and a corrected price can be re-derived from raw counters.
5. **Counters, not just dollars.** Store `input` (uncached), `cacheRead`, `cacheWrite`, `output`, `reasoning`, plus context size so tier selection can be recomputed.
6. **Every conversation of a session is in scope.** Root, forks and task-owned children are enumerated through the storage indexes (`CC#`, `CT#` on `IndexedStorage`), never only the root.
7. **No dual readers.** The old per-turn ledger shape is migrated, not kept beside the new one (AGENTS.md).

### 3.2 Data model

**Call cost record** (one per model call; the unit that makes everything else a sum):

```
ModelCallCost {
  version: 1
  conversationId       // root, fork or task-owned child
  entryId | callKey    // the assistant entry; for calls with no entry (compaction, aborted) a deterministic key
  kind: "turn_round" | "compaction" | "aborted" | "voice_understanding"
  turnId, round        // round = ordinal of the model call within the turn
  provider, model
  tokens { input, cacheRead, cacheWrite, output, reasoning, contextTokens }
  toolCallIds[]        // tool calls this response requested (per tool call or loop attribution)
  priceBookId          // e.g. "openai@2026-10-11"; names the source and date
  tier                 // "standard" | "long_context"
  costUsd | null       // null only when the model has no price; carried as `unpriced: true`, never silently zero
  recordedAt
}
```

Where it rides: **a pi-durable document per conversation** (a Chatticus `defineDoc`, the same mechanism as `ChannelLogDoc` in `conversation/src/pi/channel-log.ts`, name `chatticus.cost`), keyed by entry id, so it is committed with the session, is snapshotted and
copied with it, survives owner handoff and restart, and a restored session keeps its history. ASSUMPTION to verify in ticket S0: pi-durable's `GenerationHooks.afterResponse(message, api, context)` runs in or adjacent to the commit that records the response
and can write a document there; if it cannot, the fallback is to write the same records at the existing finalize points, idempotently keyed, which is still correct because it is keyed by entry id.

**Turn index** (messaging table, replaces the vendor ledger row; one per turn, written by the owner at turn end and on yield, park and failure, idempotent):

```
pk = {tenant}#cost#{yyyy-mm}      sk = turn#{turnId}
tenant_id, turn_id, bot_id, channel_id, prompt_author_id, prompt_message_seq, message_seq,
owner_kind ("lambda" | "computer"), root and per-child subtotals, per-model token counters,
price_book_id, cost_usd, unpriced_calls, status, updated_at, expires_at absent
```

The month in the partition key bounds rollup reads (F7) and lets a month be exported by one query. Non-turn rows (voice) use `sk = voice#{uuid}` with `bot_id` null and the posting member recorded. Attribution of a **message** is by join on `prompt_message_seq` (cost the message triggered) and `message_seq` (cost of producing the reply).
A **session or channel** total is a query over `channel_id` (GSI or a sibling item `pk = {tenant}#cost#channel#{channelId}` updated in the same transaction; decide in S0). A **bot** total is the same by `bot_id`.

**Sub-agents:** a child conversation owned by a task writes its own `chatticus.cost` document with `parentConversationId`, `parentTaskId` and the spawning tool call id. The turn index stores root and child subtotals so "what did spawning this sub-agent cost" is the child subtotal, and the parent's own cost excludes it. Loops (background anchors, repeated rounds) are visible as rounds under the same task.

**Price book:** `conversation/src/ledger/vendor-prices.ts` becomes versioned (`priceBookId`), carries input, output, cacheRead, cacheWrite and tiers for every allowed model, records its source (OpenAI's pricing page, with the retrieval date) and has a test that fails if the gateway-allowed model list and the book disagree. Chatticus computes dollars itself and keeps pi-ai's `usage.cost.total` only as a cross-check.

### 3.3 Write rules

* The **owner** (Lambda or computer, same code path) derives call records from the session at: each `afterResponse` (preferred), and at conclude, fail, yield and park as a safety net. Keyed writes mean repeats cost nothing.
* Compaction, aborted and errored responses come from `pi.usage`/hook data, not from entries.
* The **gateway** writes an `observed` item per call (`pk = {tenant}#cost#observed`, `sk = turn#{turnId}#{n}`, TTL 35 days) with raw usage and its estimate flag. A reconciliation job compares observed totals to session-derived totals per turn and flags a gap above a tolerance. The gateway no longer touches the ledger.
* A model absent from the price book is refused at the gateway (already true) **and** at the Lambda owner (new): the turn fails closed with a clear reason rather than metering zero.
* Voice understanding records the call (with `cacheRead`) into the new index with member and channel, and a failure to record is logged at error level and counted, not swallowed.

### 3.4 API (all under the member principal; an organization owner sees everyone, a member sees own prompts and channels they belong to: Q4)

* `GET /orgs/{t}/channels/{c}/cost` : session total, per-turn list, per-bot split, per-model split.
* `GET /orgs/{t}/turns/{turnId}/cost` : the call tree: rounds, tool calls, child conversations, tokens and dollars, `unpriced` markers, price book id.
* `GET /orgs/{t}/costs?group_by=bot|channel|member|model|day&from=&to=` : rollup from the monthly partitions.
* `GET /orgs/{t}/costs/export?format=csv|ndjson&from=&to=&grain=call|turn` : export of call or turn records, headers include price book id.
* `GET /orgs/{t}/costs/compare?channel=a&channel=b` (or `turn=`): side-by-side of totals and normalized metrics (cost per turn, per tool call, per sub-agent, cached ratio, rounds per turn).

### 3.5 Web

* Channel header chip: session total and a popover by bot and model.
* Per-message cost marker on each bot reply and each prompt (cost it triggered), expanding to the turn's rounds and tool calls and sub-agents.
* "Costs" page for the organization: group-by selector, date range, per-bot and per-channel bars, a table that exports.
* Compare view: pick two or more channels or turns; show totals and normalized metrics; label each with the workflow facts that differ (sub-agent count, rounds, models).
* Honest states: "unpriced", "estimated after interruption", "price book changed" are shown, never hidden. Copy says "model token cost at published list prices", never "your bill".

### 3.6 Reconciliation, parity and portability

* **Parity guard (G6):** a vitest structural guard enumerates every call site that can reach a model (`completeSimple`, `streamSimple`, harness generation, compaction, gateway) against an allowlist of metered ones; adding an unmetered caller fails the test. A Gherkin scenario drives a sub-agent and a compaction and asserts the turn total equals the sum of session records. `AGENTS.md` gains a one-line rule: a feature that creates conversations, calls a model, or moves a session must carry cost accounting in the same PR.
* **Handoff and crash:** scenarios for takeover mid-round, crash after a call but before finalize, retry of the same turn, yield/park/resume, and Lambda to computer to Lambda; each asserts the session-derived total equals the sum of calls exactly once.
* **Portability:** the cost document is part of the session partition; a session copy test asserts the copied partition reproduces the same totals with no other table.
* **Migration:** a one-shot job converts existing `{tenant}#vendor_ledger` rows into turn index items (tokens and dollars preserved, `priceBookId = "legacy"`, dimensions filled from the turn record where it still exists, otherwise null), then deletes the old rows; the rollup and the budget code read the new shape only.

### 3.7 Proposed Gherkin scenario list

New feature files, added to `features/cucumber-features.txt`: `cost_call_records.feature`, `cost_session_portability.feature`, `cost_attribution.feature`, `cost_api.feature`, `cost_gateway_reconciliation.feature`, `web_costs.feature`.

1. A computer-owner turn is counted exactly once (regression for F1).
2. A Lambda turn, a parked turn resumed on the computer, and a computer turn handed back to Lambda sum each call exactly once.
3. A crash after a model call and before finalize does not lose or double the call.
4. A retried turn re-derives the same call records.
5. A yielded turn leaves its calls recorded before the next attempt starts.
6. A call with cached input is priced at the cache rate; an input above the long-context threshold is priced at the tier rate.
7. Reasoning tokens are shown within output and priced as output.
8. A model missing from the price book fails the turn closed on Lambda and is refused at the gateway.
9. A turn that switches model prices each call at its own model.
10. A compaction summary call appears as a `compaction` record in the turn's cost.
11. An aborted or errored response with usage is recorded and marked.
12. A gateway interruption records an observation flagged `estimated` and does not change the ledger total.
13. Reconciliation flags a turn whose observed and session-derived totals differ beyond tolerance.
14. A sub-agent's cost is attributed to the child and rolled into the turn, not the parent's own cost.
15. A fork's cost is counted once and not in its parent.
16. Cost per tool call: the response that requested a tool is linked to that tool call.
17. Cost per message: a prompt message shows the turn cost it triggered; a bot reply shows the cost of producing it.
18. Cost per bot and per channel sum to the organization total.
19. Voice understanding is recorded with member and channel and a recording failure is reported.
20. A copied session partition reproduces the same totals.
21. Cost API: a member sees own and channel costs; a non-member is refused; an owner sees all (per Q4).
22. Export returns call records with the price book id.
23. Compare returns normalized metrics for two channels.
24. The web channel header shows the session total; the message marker expands to rounds; the Costs page groups by bot; unpriced calls are labelled.
25. Migration of legacy ledger rows preserves totals.
26. Adding a model caller without metering fails the parity guard (vitest, structural).

## 4. Work split and dependencies

| Id | Work | Depends on | Files (principal) |
| --- | --- | --- | --- |
| T1 | Failing scenario for F1 (computer owner counted twice) plus decision record: single writer | none | `features/cost_call_records.feature`, steps under `conversation/features-support/steps/` |
| T2 | S0 spike: pi-durable `afterResponse` document write, `pi.usage` reading, child-conversation enumeration; write findings to this doc | none | `docs/COST_ACCOUNTING.md` (spike notes), throwaway code outside `conversation/src` |
| T3 | Versioned price book with cache, tiers, source; fail-closed unpriced; supersedes `chatticus-12ba7f` | none | `conversation/src/ledger/vendor-prices.ts`, `ledger/vendor-ledger.ts`, `gateway/model-gateway.ts`, `turn/openai-models.ts` |
| T4 | Call records in the session (`chatticus.cost` doc), idempotent keyed writes, turn index, retire delta counters and gateway ledger writes (fixes F1, F3, F5) | T1, T2, T3 | new `conversation/src/ledger/call-cost.ts`, `turn/finalize.ts`, `turn/executor.ts`, `gateway/model-gateway.ts`, `store/turn-store.ts`, `computer/host/src/owner-deps.ts` |
| T5 | Complete metering: compaction, aborted, voice with member and channel, gateway observations and reconciliation job | T4 | `voice/understanding.ts`, `domain/voice-messages.ts`, `gateway/model-gateway.ts`, new `conversation/src/ledger/reconcile.ts` |
| T6 | Sub-agent and fork accounting plus parity guard and AGENTS.md rule | T4 (spike T2) | `conversation/src/turn/finalize.ts`, `storage/indexed-storage.ts` queries, guard test under `conversation/test`, `AGENTS.md` |
| T7 | Migrate legacy ledger rows to the turn index; rollup reads the new shape | T4 | `conversation/src/budget/runner.ts`, `budget/budget-store.ts`, `conversation/src/migration/` |
| T8 | HTTP cost API (channel, turn, org rollup, compare, export) | T4, T7 | `conversation/src/http/routes/costs.ts`, `http/app.ts`, `domain/costs.ts` |
| T9 | Web: channel chip, message markers, Costs page | T8 | `web/lib/costs.ts`, `web/components/ChannelCostChip.tsx`, `web/app/chat/` page, `web/lib/api.ts` |
| T10 | Web: compare view and export | T8, T9 | `web/components/CostCompare.tsx`, `web/lib/api.ts` |

T1, T2, T3 start in parallel. T4 is the pivot. T5, T6, T7, T8 fan out after T4. T9 then T10 follow T8. Each ticket in Kanbus carries its exact files and acceptance check.

## 5. Open questions for the owner

1. **Sole writer.** Agree that the owner derives dollars from the session and the gateway becomes a meter-and-enforce point that only writes reconciliation observations? The alternative (gateway authoritative, session cross-checked) records vendor-seen truth for aborted calls but ties the record to the Front Door instead of the session, which cuts against "rides with the session".
2. **Price source of truth.** Is OpenAI's published price page the contract, with a recorded retrieval date per price book? Who verifies it and how often (manual on a ticket, or a scheduled check that fails when it drifts)? Today's book comes from LiteLLM.
3. **What counts as direct cost.** Model tokens only (the vision), or also computer time per turn (Fargate seconds), snapshot storage and transfer, and Cognito/Lambda? This plan covers model tokens; AWS is metered separately by Cost Explorer and the rollup.
4. **Who can see what.** Organization owners see all costs; do ordinary members see their own prompts, channels they are in, or nothing? Are per-member costs acceptable to show to other members?
5. **Unpriced behavior.** Fail the turn closed (this plan's default), or run and flag? Closed is safer for transparency and worse for a model rollout.
6. **Comparison unit.** Is comparing two channels enough, or should a session carry a free-form "way of working" label (for example "sub-agents per task") that the compare view groups on? A label is a new product surface.
7. **Retention.** Keep call-level records forever (they ride in the session, so they live as long as it does) or cap and keep only turn rollups after N months? Export on demand is assumed either way.
8. **Currency of the claim.** The marketing site may say Chatticus measures model token cost per turn for operators today. It must not say that members can see it until T8 and T9 ship. Confirm that wording boundary.
9. **Ceilings.** Should per-turn or per-session dollar ceilings in the gateway (G7) ride in this epic or stay a budget-epic item (`chatticus-2e3e94`)?

## 6. Kanbus

Epic and children are created on the board in a separate commit to `develop` (project management, no pull request). Their ids are listed in the pull request description and in the audit report; look them up with `kbs list --search "cost accounting"`.
