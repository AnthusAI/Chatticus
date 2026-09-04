# Coordination substrates

## What this category means

How multi-agent systems **share state and work**: versioned issue boards, sync daemons, git-ledger graphs, plans-in-repo blackboards, gossip overlays. Not "who has an LLM" — the substrate under desks.

| Pattern | What it is | Implication for Chatticus |
| --- | --- | --- |
| Plans-in-repo blackboard | Agents coordinated via shared numbered plans in a monorepo; Fowler accidental blackboard / tuple space; Talwrn as intentional non-git channel | Emergent multi-agent coord without a product. Chatticus channel + shared FS can host this; git-plans alone may not be enough |
| Beads sync | Dolt-backed / git-ledger issue graph for agents; Gas Town/Wheelhouse backbone | Powerful for coding orgs; Kanbus docs argue sync/daemon friction and monolithic JSONL conflicts |
| Kanbus gossip + files | Files-only issues (one file per issue); git = truth; gossip + overlay for realtime; explicit vs Beads | Anthus-shaped alternative: versioned board without Beads daemon. Watch as Chatticus work-tracking choice (or integration), not as external competitor |

## Why it matters for Chatticus

Differentiator to watch: **how desks share state**. Document the choice deliberately — competitive story vs Yegge *and* a reliability story. Kanbus is the official Anthus coordination path for Chatticus steering; Beads and blackboard are peers/patterns.

## Products / patterns in this category

| Name | One-line | Overlap |
| --- | --- | --- |
| [Beads](../products/beads.md) | Agent issue graph (Dolt / git-ledger) | Med (substrate peer) |
| [Gas Town / Wheelhouse](../products/gas-town-wheelhouse.md) | Orchestrator bonded to Beads/work graph | High (uses Beads) |
| Kanbus (Anthus) | Files-only issues + gossip overlay | Official coordination for Chatticus |
| Fowler blackboard / Talwrn | Plans-in-repo accidental blackboard | Pattern (not product peer) |

Primary sources for patterns:
- https://martinfowler.com/articles/exploring-gen-ai/an-accidental-blackboard.html
- https://beads.gascity.com/
- Kanbus docs: `REALTIME.md`, `VS_BEADS.md` (in Kanbus repo)

## Related categories

- [Coding-org orchestrators](coding-org-orchestrators.md)
- [Multi-desk farms](multi-desk-farms.md)
- [Metaphors](../metaphors.md)
