# OpenAI Codex

OpenAI’s coding agent across web, CLI, IDE, and macOS app — cloud containers for background tasks, local OS sandbox for interactive work, and an **open harness** (App Server / JSON-RPC) that partners embed. Coding-worker axis; sibling to [Cursor Cloud Agents](cursor-cloud-agents.md). **Not** a multi-desk office.

## What it is / who for

Developers and teams using ChatGPT / Codex surfaces to delegate coding work: cloud threads that clone a repo into an isolated environment and return diffs/PRs; local CLI/IDE threads that edit the machine under OS sandbox + approval modes; integrators who embed the same harness via App Server, Codex Exec, or SDK.

## Cage / durability (short)

| Surface | Cage | What’s durable |
| --- | --- | --- |
| Cloud threads | Isolated cloud container / microVM; network often off by default during the run | Task-scoped; environment destroyed after handoff; setup via `codex-universal`-style images + caching |
| Local CLI / IDE | Platform-native OS sandbox (macOS / Linux / WSL / Windows); writable roots + approval policy | The user’s real workspace; blast radius is config (`sandbox_mode`, approvals) |
| Harness | Shared agent loop behind App Server (JSON-RPC); also explored as MCP | Protocol/product surface, not a household computer identity |

Framing cite: [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/) (2026-02-04) — one harness, many clients; App Server as the embed path (“Codex as open harness”).

## Overlap with Chatticus

**Medium (coding-worker sibling).** Ephemeral/task computers and sandboxed execution rhyme with our summoned host; approvals rhyme with consequential gates. **Low** on product shape: single coding agent / harness, not named multi-bot farm, not org shared computer with cookies, not customer-AWS ownership pitch.

## Differentiation

**They have / Chatticus doesn’t emphasize:** GA coding distribution (web + CLI + IDE + desktop), open embeddable harness, cloud network-isolated PR workers, local OS sandbox modes.

**Chatticus positioned / they don’t:** persistent org `computer_id` + S3 pack in the **customer** account; multi-named desks; household/ops non-coding work; MIT + bring-your-own-AWS ladder.

Do **not** treat Codex cloud containers as interchangeable with Chatticus hosts — no shared org browser profile, no multi-bot screens, task lifetime vs workplace identity.

## Categories

- [Coding-org orchestrators](../categories/coding-org-orchestrators.md)
- [Software factories](../categories/software-factories.md)
- [Shared-computer bot teams](../categories/shared-computer-bot-teams.md) (adjacent — task computer, not office twin)

## Freshness / status

Shipping / evolving 2026 across cloud + local surfaces. Confidence: Med–High on architecture shape (OpenAI engineering + sandbox docs); exact production microVM vs container wording varies by surface — prefer “isolated cloud environment” unless citing a specific teardown.

## Primary sources

- https://openai.com/index/unlocking-the-codex-harness/
- Codex cloud environment / `codex-universal` docs (OpenAI + community runbooks)
- https://learn.chatgpt.com/docs/sandboxing (local sandbox modes)
- Secondary: Cobus Greyling sandboxing notes; Codex cloud agent guides (2026)

## Related wiki pages

- [Cage and lasting memory](../cage-and-lasting-memory.md)
- [Cursor Cloud Agents](cursor-cloud-agents.md)
- [Claude Code](claude-code.md)
- [Devin](devin.md)
- [Factory 2.0](factory-20.md)
- [OpenAI Operator](openai-operator.md) (browser/task agent — different product)
