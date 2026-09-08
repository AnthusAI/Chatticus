# Cage and lasting memory — five-way compare

**Date:** 2026-09-08  
**Purpose:** Axes note for how Chatticus’s shared computer + lasting mind line up with Claude Code (phone), Instinct, Cursor Cloud Agents, and Grok Bot. Product dossiers stay on [product pages](index.md). Freeform research memo: `/workspace/research-cage-compare-2026-09-08.md` (outside this tree).

**Chatticus SoT:** `docs/PRODUCT.md`, `docs/COMPUTER_SNAPSHOTS.md`, `docs/COMPUTER_MANIFOLD.md`, `docs/ARCHITECTURE.md`, and README “What is live today” on `develop` (host-disk story closed 2026-09-08; live file-recycle lab UpdateStack still open).

**External teardown:** [Rohan Adwankar — The box an agent runs in](https://rohanadwankar.github.io/posts/platforms.html) (Claude Code phone + Instinct).

## Design space in one sentence

Agents are getting a **computer**. The fork is what is **durable**: the machine (or a portable pack of it), or the **mind** while the box is throwaway — and who owns the fleet.

## One-line matrix

| | Durable thing | Mind location | Shared multi-bot PC? | Who owns fleet |
| --- | --- | --- | --- | --- |
| **Chatticus** | S3 pack (customer account) | Dynamo (off box) | Yes (org) | Customer AWS + Anthus control plane |
| **Claude Code (phone)** | Block volume (`vda` reattaches) | On VM disk | No | Anthropic |
| **Instinct** | Git bundle in S3 | `/memory` Markdown vault | No (single agent) | E2B rented |
| **Cursor Cloud Agents** | Task VM / git + Builds | Cursor product backends | No (ephemeral workers) | Cursor |
| **Grok Bot** | Persistent cloud PC | Per-bot + shared PC | Yes (user) | Cursor / xAI |

## Chatticus (ours)

Hybrid on purpose:

- **Computer axis ≈ Claude Code:** workplace outlives compute. Host dies; `/workspace` + browser profile survive as an S3 pack (`chatticus-snapshots-{OrganizationId}` in the **customer** account), then hydrate onto the next host. Not live migration — publish → relocate → hydrate. One org `computer_id`, shared cookies/files across bots, separate screens.
- **Mind axis ≈ Instinct:** bot memory, chats, skills live in Dynamo / control plane — **not** on the computer disk. Computerless turns prove the split.
- **Fleet ≠ either:** compute runs in the **customer** AWS account (self-containment). Not Anthropic’s fleet, not rented E2B, not Cursor’s coding orbit.

Gates: model / workspace / browser are independent. Reads can serve from the published pack without a host; writes need a hydrated host disk. EFS was chosen then measured out — **not** current; S3 packs are the running system.

Kanbus anchors: `chatticus-fccc4e9a` (host disk decided), `chatticus-598be488` (cross-account), `chatticus-fbae4eb4` (EFS campaign stopped), `chatticus-863f27b6` (file survives recycle — Gherkin on develop).

## Claude Code (phone)

- Cage: Anthropic Firecracker microVM; sealed `process_api` as PID 1; egress gateway 443 MITM.
- Durable: tenant writable disk (`vda`) reattaches after idle reclaim; harness/skills on read-only disks.
- Mind: conversation continuity on that disk — the machine *is* lasting state.
- Fleet: Anthropic-operated.

**vs Chatticus:** same “workplace outlives compute” instinct; different mechanism (reattach volume vs portable S3 pack). We need packs because hosts are heterogeneous (garage Mac + Fargate) and customer-owned. Do not copy “the VM is the product.”

## Instinct

- Cage: rented E2B Firecracker Ubuntu (~1s boot), disposable.
- Durable mind: `/memory` Markdown vault, agent-authored git commits, pushed as a **git bundle** to S3 with short-lived STS.
- Browser “you”: separate leased cloud Chrome + **vault fill** (secrets never in chat / never on the sandbox).
- Brain: off-box; sandbox is pure execution.

**vs Chatticus:** steal vault-fill and visible Markdown memory UX *later* (wiki/mind layer). Do **not** put lasting mind into `/workspace` (dual-write / split brain). Do **not** rent the fleet while pitching customer-account files. A leased browser identity is a threat-model change vs shared org cookies.

Product card today is thin (messaging/trust framing): [Instinct](products/instinct.md).

## Cursor Cloud Agents

- Cage: isolated Firecracker microVM per agent (Cursor docs); coding desktop + browser for the run.
- Lifetime: provision → work → draft PR → hibernate/delete on idle. Builds warm the repo snapshot.
- Mind: not a personal Markdown vault — git branch + PR, conversation/artifacts in Cursor backends.
- Multi-agent: parallel coding workers, not named office desks on one shared PC.

**vs Chatticus:** ≈ summoned host only in “spin compute for a job.” No persistent household `computer_id`, no shared org cookies, no customer-AWS ownership story. Cursor is the **distribution orbit** Grok Bot rides; Chatticus sits outside it on purpose.

See [Cursor Cloud Agents](products/cursor-cloud-agents.md).

## Grok Bot (product twin)

- Cage: Cursor cloud Firecracker microVM — one **user-scoped** persistent cloud computer.
- Durable computer: shared FS / browser / terminal across that user’s bots (delete bot ≠ wipe computer; Reset Computer = recovery).
- Mind: per-bot memory + skills/routines; computer is the shared workplace.
- Approvals / Auto Review; connectors first; bot-to-bot handoffs; separate screens.

**vs Chatticus:** near architectural twin on cage / sharing / skills / routines. Differentiate on **ownership (MIT + customer AWS)**, org/farm brand, household → multi-tenant, trust UX (wipe vs reset, credential boundaries), non-Cursor distribution. Do not describe Chatticus as a clone.

See [Grok Bot](products/grok-bot.md) and [Shared-computer bot teams](categories/shared-computer-bot-teams.md).

## Steal / avoid

**Steal**

1. Instinct **vault-fill** so secrets stay out of chat — fits consequential binding + approval cards.
2. Instinct’s **visible Markdown vault** (entities / timeline coarsening / agent as author) as a *mind* UX later — adjacent to Kanbus wiki / Agent Zoo; keep it off `/workspace`.
3. Claude’s clean **yours-RW / theirs-RO** disk split — we already have ECR image vs snapshot pack; keep the line bright.
4. **Short-lived STS** (or equivalent) to the pack store — kill anything that smells like long-lived host keys.

**Avoid**

1. Claude’s “VM is the product” — breaks multi-host + customer-account portability.
2. Instinct’s mind-as-files-on-the-sandbox conflation — lasting mind stays off the computer.
3. E2B-style rented fleet while selling “their account, their files.”
4. Leasing a separate browser identity without a conscious threat-model change to the shared-org cookie boundary.
5. Blurring Cursor task VMs with our `computer_id`.

## Related pages

- [Metaphors](metaphors.md)
- [Shared-computer bot teams](categories/shared-computer-bot-teams.md)
- [Grok Bot](products/grok-bot.md) · [Instinct](products/instinct.md) · [Cursor Cloud Agents](products/cursor-cloud-agents.md) · [Claude Cowork](products/claude-cowork.md) (local Anthropic surface; not the phone Firecracker box)
- Design docs: `docs/PRODUCT.md`, `docs/COMPUTER_SNAPSHOTS.md`, `docs/COMPUTER_MANIFOLD.md`
