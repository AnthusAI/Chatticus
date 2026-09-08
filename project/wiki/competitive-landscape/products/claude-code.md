# Claude Code

Anthropic’s coding agent. **Distinct from** [Claude Cowork](claude-cowork.md) (local desktop computer-use). This card covers the coding harness and especially the **phone / remote Firecracker** box measured by Adwankar: durable tenant disk (`vda`), sealed in-guest operator, read-only harness disks.

## What it is / who for

Developers using Claude Code locally (CLI / IDE) and on phone / remote surfaces where the agent runs in Anthropic-operated compute. Coding-worker and durable-machine axes — not a multi-bot office product.

## Cage / durability (phone box — Adwankar)

| Axis | Fact |
| --- | --- |
| Isolation | Anthropic **Firecracker** microVM (KVM); guest kernel `*-fc-*` |
| Operator | Rust `process_api` as **PID 1** on vsock :2024; sealed (non-dumpable, `/proc/1/mem` denied) |
| Durable | Writable virtio disk **`vda` (~256G)** survives idle reclaim and **reattaches** on next boot |
| Harness | ~324 MB Bun binary on **read-only** disk (`/opt/claude-code`); skills on other RO disks |
| Egress | 443-only MITM gateway; `api.anthropic.com` pinned; **no inbound**; inference SSE `/v1/messages` |
| Cold path | ~430 ms init; ~6.4 s to harness |

Local Claude Code / Cowork use **different** containment (OS sandbox, local hypervisor patterns) — see Anthropic “How we contain Claude”; do not collapse phone Firecracker with local Cowork.

## Overlap with Chatticus

**Medium–High on durable workplace instinct.** Chatticus also wants the workplace to outlive compute — but via **portable S3 packs** on customer-owned hosts (Mac + Fargate), not one Anthropic-reattached volume. **Low** on multi-bot farm / org shared computer / customer-AWS commercial bet.

Full axes: [Cage and lasting memory](../cage-and-lasting-memory.md).

## Differentiation

**They have:** sealed Firecracker guest, machine-as-durable-state, Anthropic fleet, coding-first distribution.

**Chatticus:** customer-account packs + multi-host `computer_id`; mind in Dynamo (off box); named desks; MIT / BYO-AWS. Avoid copying “the VM is the product” — it fights garage Mac + Fargate portability.

## Categories

- [Coding-org orchestrators](../categories/coding-org-orchestrators.md)
- [Software factories](../categories/software-factories.md)
- [Shared-computer bot teams](../categories/shared-computer-bot-teams.md) (durable machine adjacency; not office twin)

## Freshness / status

Phone Firecracker facts: Adwankar teardown 2026-09 (high confidence for that surface). Local harness / Cowork: separate cards and Anthropic posts. Confidence: High on phone cage; Med on product roadmap.

## Primary sources

- https://rohanadwankar.github.io/posts/platforms.html
- Anthropic containment engineering posts (local ≠ phone box)
- Claude Code product / docs (Anthropic)

## Related wiki pages

- [Cage and lasting memory](../cage-and-lasting-memory.md)
- [Claude Cowork](claude-cowork.md) — local desktop computer use; **do not merge**
- [OpenAI Codex](openai-codex.md)
- [Cursor Cloud Agents](cursor-cloud-agents.md)
- [Instinct](instinct.md) — opposite durability (throwaway box + Markdown mind)
- [Grok Bot](grok-bot.md)
