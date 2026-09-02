# Persistent agents and latency arbitrage

**Living memo — verified through September 2, 2026**

## Purpose

This memo preserves the developing argument about the economics of persistent, scheduled AI agents. It is intended to survive the originating conversation and serve as the starting point for later product strategy, architecture, implementation, or writing.

The central claim is narrower—and stronger—than generic advice about reducing AI costs:

> **Persistent agents turn latency from user-facing pain into schedulable slack. For work whose inputs are available sufficiently ahead of its deadline, run the same prompt, tools, and model through the cheapest service tier that can finish on time. Batch and Flex reduce cost by spending patience rather than sacrificing intelligence or output quality. Start scheduled work earlier, monitor its remaining slack, and buy faster service only when necessary to protect the deadline.**

In shorter form:

> **Do not replace the model with a cheaper brain. Give the same brain more time.**

The product insight is **time arbitrage**, not model arbitrage.

---

## 1. The quality-preserving boundary

Several different cost optimizations are often discussed together. They should be separated because they make different promises.

| Optimization | What changes | Quality risk | Role in this thesis |
|---|---|---:|---|
| Use Batch with the same model | Scheduling and completion latency | No intended quality concession | Core |
| Use Flex with the same model | Scheduling priority, latency, and availability | No intended quality concession | Core where available |
| Start a scheduled task earlier | Wall-clock schedule | No intended quality concession | Core |
| Cache an exact reusable prompt prefix | Billing and repeated computation | Normally none | Complementary |
| Use a smaller or different model | Model capability and behavior | Material | Out of scope |
| Remove or compress context | Information available to the model | Possible | Out of scope unless proven safe |
| Reduce reasoning effort or output budget | Computation and answer depth | Possible | Out of scope |

Model routing may be useful general cost advice, but it is not a substitute for the argument here. Results from two models are not interchangeable merely because both produce plausible prose. A cheaper model may lose reliability on precisely the task that justified building the agent.

The clean counterfactual is therefore:

> **Same task + same prompt + same tools + same model snapshot + same inference parameters; only the start time and processing tier change.**

“Same results” should be understood as the same intended quality distribution, not identical output bytes. Generative inference can vary between repeated calls even when every request parameter is held fixed. Pinning a dated model snapshot, prompt version, tool policy, and inference parameters makes the quality-preserving claim as rigorous as the provider permits.

This is why the savings can reasonably be described as “free” in one specific dimension: **they do not require intentionally lowering answer quality**. They are not literally frictionless. They consume patience, increase work in progress, add scheduling and recovery machinery, and can increase deadline risk if used badly.

---

## 2. Why persistence changes the economics

Interactive AI has a person waiting for the next token. Latency is immediately visible, so faster service can have real value.

A persistent background agent is different:

- It can be triggered before its output is needed.
- It can suspend while external inference is queued.
- It can resume after the result arrives.
- It can checkpoint progress across a multi-step workflow.
- A scheduler can pool compatible work from many agents.
- The user can receive the result at the same delivery time even though the computation began earlier.

Persistence does **not** make latency worthless. It makes latency **schedulable**.

Latency still matters when it affects freshness, downstream dependencies, incident response, retry time, human feedback, or a delivery deadline. The correct rule is not “Fast is always dumb in the background.” It is:

> **Do not buy latency whose marginal value is lower than its premium.**

For periodic scheduled work, the deadline is known before the request exists. That predictability creates a special opportunity: preserve both output quality and delivery time by moving the start time earlier.

---

## 3. The feasibility test

Every scheduled run has at least two different clocks:

1. **Input availability and freshness:** When are the necessary inputs available, and how current must they be?
2. **Output deadline:** When must the completed result be delivered?

Starting earlier works only when the required inputs exist early enough.

A simple feasibility condition is:

```text
input-ready time
+ expected or guaranteed service window
+ remaining workflow time
+ retry and recovery margin
<= output deadline
```

For dynamic routing, define remaining slack as:

```text
slack = deadline
        - current time
        - p95 remaining critical-path duration
        - retry margin
```

The system should choose the cheapest same-model lane compatible with the required probability of finishing on time. As slack disappears, it can promote the unfinished work to a faster lane.

This produces a natural ordering:

1. **Batch:** high-slack, replayable, independent, or provider-contained work.
2. **Flex or equivalent:** low-priority same-model requests that need normal request semantics but can tolerate slower processing and occasional unavailability.
3. **Standard:** work on a tighter critical path or work that needs predictable ordinary service.
4. **Fast:** interactive work, incidents, or deadline rescue where earlier completion is worth the premium.

Flex should not be treated as a guaranteed middle SLA. OpenAI describes it as slower and subject to resource-unavailable errors and timeouts. It needs retries and a Standard fallback when a deadline is important.

---

## 4. Scheduled work is the best initial target

Periodic tasks are unusually attractive because their delivery times, input cycles, and recurrence are predictable.

Strong candidates include:

- Weekly audits whose source data is stable well before delivery.
- Overnight analysis of a completed business day.
- Repository-wide classification, extraction, or summarization.
- Scheduled documentation maintenance.
- Rolling research whose final synthesis is due later.
- Background enrichment of records that have no immediate consumer.
- Precomputation for a report, review, or planning session.

The phrase “start it a little sooner” is exactly right when the inputs permit it. If a weekly report is due Monday morning and its relevant source period closes Friday, a long processing window need not delay delivery at all.

The important exception is a freshness-bound job. A report due at 8:00 a.m. that must contain data through 7:55 a.m. cannot simply be submitted the night before. Its useful slack is five minutes, not eight or twenty-four hours.

That case can sometimes be split:

1. Batch the stable historical analysis and expensive background work early.
2. At the deadline, obtain the fresh delta.
3. Perform a small last-mile update or synthesis through Flex, Standard, or Fast.

This split preserves freshness without paying the latency premium for the whole job.

Recurrence period is not itself the latency limit. Independent hourly runs can overlap and complete later. A long service window becomes a problem when runs depend on prior outputs, cannot overlap safely, hold scarce resources, or become stale before consumption.

---

## 5. The bot-farm architecture implied by the thesis

The essential primitive is not merely a persistent agent identity. It is a **suspendable, resumable workflow**.

An always-on agent that holds an expensive cloud computer open while waiting for a queued request could convert cheap inference into expensive idle infrastructure. The agent should checkpoint, release active resources, and resume from durable state.

### 5.1 Represent work as a resumable graph

Each run should be represented as a state machine or directed acyclic graph where possible. A stage becomes runnable only when its required inputs exist. The scheduler should pool compatible runnable stages across all agents rather than forcing each agent to submit its own isolated batch.

Batchability is not determined solely by whether a node is a “leaf.” An internal fan-out or provider-contained subgraph may be batchable if it has sufficient downstream slack. Conversely, a leaf immediately before delivery may be too urgent.

The useful scheduling unit is:

> **A ready, independently retryable inference stage—or a whole provider-contained subgraph—with enough remaining deadline slack.**

Client-managed inference → tool → inference loops deserve special care. Later prompts do not exist until earlier tool results arrive. Sending every turn through a separate long-window batch can make latency additive. Options include:

- Keep the sequential spine on Flex or Standard.
- Batch parallel map, classification, extraction, or synthesis stages around it.
- Place a contained agentic loop inside one provider request where the provider's Batch feature and tool support permit it.
- Checkpoint between every stage so a failed or expired request can be replayed safely.

### 5.2 Record the scheduling contract

At minimum, each job or stage should carry:

- `model_snapshot`
- `prompt_version`
- `tool_policy_version`
- `ready_at`
- `source_data_cutoff`
- `due_at`
- `fresh_until`
- `quality_floor`
- `deadline_reliability_target`
- `soft_cost_target`
- `hard_cost_cap`, if one truly exists
- `retry_budget`
- `rescue_reserve`
- `idempotency_key`
- predicted p50, p95, and p99 duration by eligible service tier

The model and quality fields are constraints, not variables to be silently relaxed by the cost optimizer.

### 5.3 Start cheap and promote as slack burns

A practical policy is:

1. Launch through the cheapest eligible same-model lane as soon as the inputs are ready.
2. Observe actual queue and completion behavior.
3. Calculate the latest safe start for a fallback attempt.
4. If the cheap attempt remains incomplete at that point, cancel it where possible or hedge it through Standard/Fast.
5. Accept the first valid result and reconcile duplicate side effects safely.

The rescue path is deadline insurance. It may occasionally erase the savings for one run, but it can still minimize expected cost over many runs while protecting the delivery objective.

Hard cost caps and hard deadlines can conflict. A policy must say which one wins:

- **Deadline-first:** permit a rescue premium.
- **Budget-first:** allow lateness, degradation, skipping, or failure.
- **Quality-first:** preserve the model and task requirements even if time or cost expands.

Pretending all three are absolute merely hides the decision until the failure occurs.

---

## 6. Economics: what “half” really means

OpenAI and Anthropic currently advertise a 50% discount for eligible Batch token usage. That can halve the token charge for the same supported model.

It does **not** automatically halve:

- Every inference call in a multi-step workflow.
- Tool, browser, retrieval, storage, or computer-use charges.
- Agent-hosting and orchestration costs.
- Retry, expiration, and rescue costs.
- Human review or rework costs.
- The total cost of operating the bot farm.

A useful approximation is:

```text
gross system savings rate
= inference share of total cost
  × batch-eligible share of inference
  × provider discount
```

Then subtract added orchestration, retry, deadline-miss, rescue, and rework costs.

For example, if inference is 60% of total system cost, 70% of inference is eligible, and Batch discounts it by 50%, gross total-system savings are:

```text
0.60 × 0.70 × 0.50 = 0.21, or 21%
```

That is still an excellent result, but it is different from claiming the whole bot farm becomes 50% cheaper.

There are two useful comparisons:

- **Standard → Batch:** a 50% reduction in eligible OpenAI or Anthropic token charges.
- **Fast → Batch/Flex:** currently a 4× price spread for supported OpenAI GPT-5.6 Sol usage, meaning a workload incorrectly routed to Fast could reduce that eligible token charge by 75%.

The second comparison combines removal of an unnecessary Fast premium with the Batch/Flex discount. The normal marginal decision for a competently routed background job is Standard versus Batch or Flex.

Provider discount percentages alone do not determine the cheapest provider. Base prices, output length, tool fees, model quality, retries, feature support, and reliability all matter. But changing provider or model also reopens the quality question and is therefore a separate evaluation from this same-model scheduling thesis.

Public API prices also do not establish Grok Bot's internal marginal costs or prove that the product uses the public xAI Batch API. The pricing comparison is evidence for a bot-farm design pattern, not evidence about xAI's confidential internal routing.

---

## 7. What Kimi's report got right

The Kimi/Perplexity report independently identified several important points:

- Background work can often tolerate slower processing.
- OpenAI and Anthropic offer larger Batch discounts than xAI offers on selected models.
- Deadlines and service expectations constrain cost optimization.
- Sequential tool loops can compound queue latency.
- Batch integration has a real engineering break-even point.
- Per-run cost telemetry should exist from the beginning.
- The meanings of “Fast” in a model name and an expensive processing tier must not be confused.

Its most durable recommendation is to write down the latency objective for each task and buy no more speed than required.

---

## 8. Corrections and disagreements with Kimi

### 8.1 Model routing is not a free substitute

Kimi argues that smaller-model routing may be a larger lever than Batch. That might be true for generic cost reduction, but it changes the model and can degrade task performance. It is not part of a quality-preserving patience-for-cost trade.

The relevant optimization order for this thesis is not “pick the cheapest model first.” It is:

1. Select and validate the model required for the task.
2. Treat that model and its quality as fixed.
3. Choose the cheapest service schedule that meets freshness and deadline requirements.

### 8.2 The Little's Law statement is backward

Kimi says that increasing latency while throughput remains fixed “barely moves” work in progress. Little's Law says:

```text
work in progress = throughput × mean time in system
```

At fixed throughput, increasing mean latency increases work in progress proportionally. A twelvefold increase in latency creates twelve times as many outstanding jobs.

The economic conclusion can still hold for a different reason: queued work may have a low carrying cost when it is durably checkpointed, holds no active compute, has generous separate quotas, and can overlap safely. Little's Law does not prove that; good infrastructure can merely make the increased work in progress inexpensive and manageable.

### 8.3 “After midnight, by morning” is not guaranteed

Submitting a request after midnight to a system with a 24-hour completion or expiration window does not establish that it will finish by 8:00 a.m. An eight-hour deadline needs measured tail behavior, an explicitly accepted miss rate, or a fallback lane.

### 8.4 Flex is not a five-minute SLA

OpenAI Flex retains ordinary request semantics and Batch-rate token pricing on supported models, but the provider warns of slower responses, timeouts, and resource-unavailable errors. It is useful for lower-priority sequential work, not a standalone guarantee for a tight deadline.

### 8.5 The xAI characterization is outdated and too broad

xAI's current 20% Batch discount applies to listed Grok 4.3 and Grok 4.20 variants. Current Grok 4.5 and Grok 4.6 documentation says Batch is unsupported. Depending on model, xAI therefore provides a 20% discount, no discount, or no Batch capability—not a general “20% off flagship Grok” rule.

The report's Grok 4.1 Fast price example is also obsolete. Those model aliases were retired on May 15, 2026 and redirect to Grok 4.3 at different pricing.

### 8.6 The OpenAI Fast speed figure is stale

Kimi reports roughly 1.5× speed for roughly 2× price. Current OpenAI documentation advertises up to 2.5× faster processing for GPT-5.6 Sol. The 2× Fast price and 4× Fast-to-Batch/Flex token-price spread remain correct for the current short-context pricing example.

### 8.7 Source volume obscures source quality

The report's key facts are available in first-party provider documentation, but several claims instead rely on community posts, reseller articles, or stale third-party pricing pages. Many listed sources are not used in the body. Future work should maintain a small dated ledger of primary sources rather than a large bibliography whose entries have not all informed the analysis.

---

## 9. Measurement and observability

The correct objective is not merely cost per request. It is:

> **Cost per successful, useful, on-time run at the required quality.**

Per run and per stage, record:

- Agent, workflow, run, and stage identifiers.
- Provider, model snapshot, service tier, and request parameters.
- Input, cached-input, reasoning, and output tokens.
- Tool, retrieval, browser, computer, storage, and hosting costs.
- Submission, queue, first-response, and completion timestamps.
- Provider errors, expirations, retries, cancellations, and fallback promotions.
- Data cutoff, freshness at delivery, deadline, and whether it was met.
- Duplicate or hedged execution cost.
- Quality evaluation, acceptance, rework, and downstream usefulness.

The scheduler should learn empirical completion and failure distributions for each provider × model × tier combination. Advertised averages are insufficient for deadline protection; p95 and p99 behavior matter.

Useful aggregate metrics include:

- Batch-eligible share of same-model inference.
- Realized token discount.
- Net savings after orchestration and rescue.
- Deadline hit rate by job class.
- Promotion and hedge rate.
- Expiration and retry rate.
- Queue occupancy and oldest outstanding job.
- Quality or rework difference by service tier.
- Cost per successful, useful, on-time outcome.

---

## 10. Primary-source ledger

All provider facts below should be rechecked before publication or implementation because pricing and feature support can change.

### OpenAI

- [Batch API](https://developers.openai.com/api/docs/guides/batch): 50% lower token cost, a separate higher rate-limit pool, and a 24-hour completion window. Unfinished requests can expire at the boundary, so the window is not a guarantee that every request succeeds.
- [Flex processing](https://developers.openai.com/api/docs/guides/flex-processing): Batch-rate token pricing for supported models with ordinary single-request semantics. It remains beta with limited model availability, slower processing, possible timeouts, and possible uncharged resource-unavailable errors.
- [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode): current Fast behavior and the claim of up to 2.5× faster processing for GPT-5.6 Sol. Requests can be downgraded to Standard when ramp limits are exceeded, and eligible Enterprise contracts may attach SLA or service-credit treatment.
- [API pricing](https://developers.openai.com/api/docs/pricing): current Standard, Batch, Flex, and Fast rates. As of this memo, supported short-context GPT-5.6 Sol prices put Fast at 2× Standard and Batch/Flex at 0.5× Standard. These Sol prices are promotional through at least November 21, 2026.

### Anthropic

- [Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing): 50% pricing, most batches completing within an hour, and unfinished requests expiring after 24 hours. Batch supports active models and most Claude API features; restrictions and platform availability still apply.
- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing): current model and Batch prices.
- [Claude Platform feature availability](https://platform.claude.com/docs/en/build-with-claude/overview): deployment-platform and feature restrictions. Batch should not be generalized to every Claude host and is not eligible for zero-data-retention arrangements.

### xAI

- [API pricing](https://docs.x.ai/developers/pricing): the 20% Batch discount applies only to listed Grok 4.3 and Grok 4.20 variants; unlisted models receive no Batch discount.
- [Batch API](https://docs.x.ai/developers/advanced-api-usage/batch-api): completion is typically within 24 hours but is explicitly best effort, not guaranteed.
- [Grok 4.5](https://docs.x.ai/developers/models/grok-4.5): Batch is not supported.
- [Grok 4.6](https://docs.x.ai/developers/models/grok-4.6): Batch is not supported.
- [May 15, 2026 model retirement](https://docs.x.ai/developers/migration/may-15-retirement): retirement and redirection of Grok 4.1 Fast aliases.
- [Introducing Grok Bot](https://x.ai/news/introducing-grok-bot): launch and product description of always-on persistent agents. This does not document the product's internal inference routing or unit costs.

### PostHog

- [Making Claude Cowork actually useful](https://posthog.com/blog/making-claude-cowork-actually-useful): concrete examples of scheduled background agents and the observation that scheduled tasks can be more valuable than on-demand chat. This demonstrates the use case, not Batch adoption or its realized savings.

---

## 11. Decisions already made

Future work should not silently reopen these decisions:

1. **The thesis is about quality-preserving scheduling, not model downgrading.**
2. **The model, prompt, tool policy, and quality floor are fixed constraints for the service-tier decision.**
3. **Batch can halve eligible same-model token charges at OpenAI and Anthropic; it does not necessarily halve total system cost.**
4. **Flex is a useful same-model lane where supported, but it needs failure and deadline handling.**
5. **Fast is a rescue and high-value latency lane, not an automatic waste.**
6. **Freshness and delivery deadline are separate clocks.**
7. **The workflow must suspend and resume without holding costly active infrastructure.**
8. **The scheduler should batch compatible ready work across agents, not merely batch whole agents.**
9. **Cost is evaluated per successful, useful, on-time outcome at the required quality.**
10. **Provider facts must be dated and sourced from primary documentation.**

---

## 12. Open questions and next artifacts

The argument is mature enough to move from thesis to design. The next useful work is empirical and architectural:

1. Inventory candidate agent jobs and record their input-ready time, freshness cutoff, deadline, recurrence, model requirement, and retry tolerance.
2. Estimate the share of current LLM spend eligible for same-model Batch or Flex processing.
3. Measure real p50, p95, and p99 completion and failure behavior rather than relying only on provider windows.
4. Define the latest-safe-start and rescue policy for each job class.
5. Determine which multi-step workflows can be expressed as replayable stages or provider-contained subgraphs.
6. Quantify the carrying cost of queued work: storage, quotas, state drift, cancellations, and active-hosting requirements.
7. Run an equivalence evaluation confirming that service-tier changes do not cause a meaningful quality shift for representative tasks.
8. Build a cost model or calculator showing Standard, Batch, Flex, rescue, and total-system savings under different eligibility rates.
9. Draft the scheduler's job schema and state-transition diagram.
10. Prototype one periodic task end to end before generalizing the infrastructure.

Suggested next deliverables:

- A one-page public essay or product thesis.
- A technical architecture specification.
- A spreadsheet cost and deadline simulator.
- A minimal scheduler prototype with Batch, Flex, Standard, and rescue lanes.
- An experiment plan for quality equivalence and completion-time distributions.

---

## 13. Continuation note for a future session

Start by reading this memo. Do not reconstruct the argument from the original conversation unless a missing detail makes that necessary.

The most important conceptual boundary is that **model selection is already fixed**. The next problem is how to exploit known deadline slack without lowering task quality. The most productive continuation is probably either:

- turn this memo into a formal architecture and scheduler policy, or
- inventory actual recurring tasks and calculate the economically eligible workload.

Before quoting provider prices or capabilities externally, recheck every entry in the primary-source ledger and update the verification date at the top.

---

## Change log

- **2026-09-02:** Initial durable memo created from the Grok Bot/PostHog discussion, the Kimi/Perplexity report, primary-source verification, and subsequent clarification that model substitution is outside the quality-preserving thesis.
