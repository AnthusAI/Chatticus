---
title: Names for the workplace
description: Working notes on what people call a place where agents collaborate and do useful work.
ogHeadline: Names for the workplace
ogTagline: The thing is stable. The jargon moves.
draft: true
relatedPosts: []
---

A **workplace** (Chatticus's working picture: a **reactor chamber**) is a durable place where **named, persistent agents** hold jobs, share tools and often a computer, run in the background, and hand work to each other. It is not a chat tab, a model catalog, or a single long task. It is the organizational layer above one agent and one turn: roster, shared environment, coordination, and governance.

This note tracks what vendors, builders, and press call that layer in 2025–2026. **Agent Zoo** is Chatticus's desk *about* the category; none of the third-party names below are invitations to rename Chatticus internals.

## Names in the wild

### Strong fit — names that target this idea

| Name | Who uses it | Fit | Source |
| --- | --- | --- | --- |
| **Software factory** | Factory.ai (product name and docs) | End-to-end agent-native SDLC system: automations, missions, persistent Droid Computers, 24/7 coverage map | [Software Factory overview](https://docs.factory.ai/software-factory/overview), [Factory 2.0 announcement](https://factory.ai/news/software-factory) |
| **Gas Town** / **town** / **workspace** | Steve Yegge (`gastownhall/gastown`) | Multi-agent workspace manager; HQ (`~/gt`) orchestrates rigs, roles (Mayor, Refinery, Polecats), git-backed persistent hooks | [Gas Town repo](https://github.com/gastownhall/gastown), [Welcome to Gas Town](https://yegge.ai/essays/welcome-to-gas-town/) |
| **Grok Bot** / **Bot** (as teammate) | xAI / Cursor | Named persistent agents on a shared cloud computer; parallel bots, inter-bot messaging, routines; docs: "AI teammates" | [Grok Bot overview](https://docs.x.ai/grok-bot/overview), [Introducing Grok Bot](https://x.ai/news/introducing-grok-bot) |
| **Control room** | Anthus (participant voice on Grok Bot) | Operator metaphor for where agents are directed and coordinated—not a product name | [Grok Bot Gave My Coding Agents a Boss](https://anth.us/blog/grok-bot-gave-my-coding-agents-a-boss/) |
| **Agent Command Center** | Cognition (Devin Desktop) | Default Kanban surface for local + cloud agents, PRs, and context in one IDE | [Agent Command Center](https://docs.devin.ai/desktop/agent-command-center), [Introducing Devin Desktop](https://cognition.com/blog/introducing-devin-desktop) |
| **Spaces** | Cognition (Devin Desktop) | Project-scoped grouping of agent sessions, PRs, files, and shared context—workplace *within* the command center | [Spaces](https://docs.devin.ai/desktop/spaces) |
| **Managed Devins** / parallel sessions | Cognition | Coordinator session delegates to isolated VM workers; playbooks and schedules | [Advanced capabilities](https://cognitionai-enterprise.mintlify.app/work-with-devin/advanced-capabilities) |
| **Crew** / **Crews** | CrewAI | Teams of role-playing autonomous agents inside event-driven **Flows** | [CrewAI introduction](https://docs.crewai.com/en/introduction), [crewAI repo](https://github.com/crewaiinc/crewai/) |
| **Missions** | Factory.ai | Multi-agent autonomous execution decomposed into parallel tracks over hours or days | [Software Factory overview](https://docs.factory.ai/software-factory/overview), [Factory 2.0](https://factory.ai/news/software-factory) |
| **Agent teams** | Anthropic (Claude Code, experimental) | Multiple Claude Code instances, shared task list, mailbox, team lead—session-scoped, not a hosted org computer | [Orchestrate agent teams](https://code.claude.com/docs/en/agent-teams) |
| **Mission Control** | builderz-labs (open source) | Self-hosted **control plane** for tasks, agents, spend, schedules across runtimes (OpenClaw, Claude Code, Codex) | [mission-control repo](https://github.com/builderz-labs/mission-control), [Mission Control site](https://mc.builderz.dev/) |
| **Digital assembly line** | Google Cloud (2026 manufacturing trends), enterprise vendors (e.g. AI3X) | Human-guided multi-step workflow orchestrating multiple agents; common in enterprise pitch decks | [Google 2026 AI trends PDF](https://services.google.com/fh/files/misc/2026_ai_trends_manufacturing.pdf) |
| **Agent development environment** | PostHog | PostHog Desktop: isolated workspace per task, agent works while human reviews elsewhere | [AI platform handbook](https://posthog.com/handbook/engineering/ai/ai-platform) |
| **Multi-agent workspace** / **workspace manager** | Gas Town README, industry press | Generic descriptor Gas Town owns most visibly in open source | [Gas Town repo](https://github.com/gastownhall/gastown) |
| **The Herd** | herd-core (open source) | Governance layer for multi-agent *organizations*: roles, authority, memory, cross-host teams | [herd-core repo](https://github.com/dbt-conceptual/herd-core) |

### Adjacent — related layer, not the workplace noun

These terms show up in the same conversations but usually mean **runtime**, **harness**, **orchestration pattern**, or **single-agent execution**—not the shared org where bots clock in.

| Name | Who uses it | Why it is adjacent, not synonymous | Source |
| --- | --- | --- | --- |
| **Agent runtime** | Azure (Foundry Agent Service), Blaxel, The New Stack | Execution substrate: sessions, sandboxes, state resume—not roster or shared computer | [Agent runtime (The New Stack)](https://thenewstack.io/agent-runtime-application-server/) |
| **Agent harness** | Factory docs, Microsoft Agent Framework, industry analysts | Tool loop + memory + sandbox around **one** agent; frameworks compose agents, harnesses run them | [Factory Droid CLI](https://docs.factory.ai/droid-cli/overview), [Harness comparison](https://winder.ai/ai-agent-harness-comparison/) |
| **Agent OS** / **agentic OS** | Letta, Intueo Labs | Durable memory/identity layer under agents; coding is first app on the OS | [Letta Agent](https://www.letta.com/agent), [Intueo on Letta Code](https://www.intueo.ai/blog/how-we-run-letta-code-stateful-coding-agent-across-our-company) |
| **Agentic platform** | Enterprise architecture writing | Full stack: runtime + control plane + connectors + governance | [Rierino guide](https://rierino.com/blog/what-is-an-agentic-platform) |
| **Magentic** / **Magentic-One** | Microsoft (Agent Framework, AutoGen lineage) | Dynamic multi-agent **orchestration pattern**, not a workplace product | [Magentic orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic), [Magentic-One research](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/) |
| **Cloud Agents** (formerly background agents) | Cursor | Long-running agents on isolated cloud VMs; multi-repo environments; operator dispatches tasks | [Cloud Agents](https://cursor.com/help/ai-features/cloud-agents), [Cloud setup](https://cursor.com/docs/cloud-agent/setup) |
| **Cloud environment** / **Build** | Cursor | The prepared machine image agents boot from—infra, not the org chart | [Environment setup](https://cursor.com/docs/cloud-agent/setup) |
| **Droid Computer** | Factory.ai | Persistent execution environment for a Droid—computer slot, not the factory floor | [Software Factory overview](https://docs.factory.ai/software-factory/overview) |
| **Cowork** | Anthropic | Knowledge-work agent (Claude Code architecture, no terminal); cloud sessions; projects—not multi-bot roster by default | [Claude Cowork](https://claude.com/product/cowork/), [Get started with Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) |
| **Operator** / **agent mode** | OpenAI | Single computer-using agent per task; merged into ChatGPT as agent mode | [Introducing Operator](https://openai.com/index/introducing-operator/) |
| **Control plane** | Mission Control, enterprise | Governance and dispatch above runtimes—half of the workplace story | [mission-control repo](https://github.com/builderz-labs/mission-control) |
| **Swarm** / **hive** / **colony** | openclaw-hawkins, Mission Control AI, Verint | Hawkins: OpenClaw multi-agent **plugin** vocabulary (Nexus, Tendrils, Hive). Mission Control AI: unrelated synthetic-labor product. Verint: CX orchestration | [openclaw-hawkins](https://hawkins.parijatmukherjee.com/), [Mission Control AI](https://usemissioncontrol.com/), [Verint Agent Factory](https://www.verint.com/agent-factory/) |
| **Tactus** / **procedures** | Anthus | Agent **runtime** and procedure language (sandbox, HITL)—building block, not workplace brand | [Tactus](https://tactus.anth.us/) |

### Collisions — same word, different thing

| Name | Common meaning | Collision | Source |
| --- | --- | --- | --- |
| **Model zoo** | Catalog of pretrained model weights (Caffe Model Zoo, Hugging Face hub) | Sometimes loosely used for agent collections; historically **not** a workplace | [Hugging Face model hub](https://huggingface.co/models) (representative catalog usage) |
| **Bot farm** | Spam, click fraud, fake accounts | Occasionally legitimate multi-bot ops; toxic default connotation | Industry usage; treat as risky in Chatticus voice |
| **AI Foundry** / **Microsoft Foundry** | Model catalog, deployments, agent *service* as one pillar | Tagline "AI app and agent factory" names the **platform**, not a persistent multi-bot workplace | [Microsoft Foundry docs](https://learn.microsoft.com/en-us/azure/foundry/), [Foundry Models overview](https://learn.microsoft.com/en-us/azure/foundry/concepts/foundry-models-overview) |
| **Studio** | Builder UI / playground (Vertex AI Studio, etc.) | Chat surface, not org of named workers | Generic vendor pattern |
| **Foundry** (alone) | Azure model platform; also Factory.ai's "software factory" | Disambiguate by vendor | See above |
| **Agent factory** | Verint CX product; Microsoft marketing | Orchestration for **hybrid human+AI workforce** in contact centers—not necessarily shared computer | [Verint Agent Factory](https://www.verint.com/agent-factory/) |
| **Mission Control** | builderz-labs control plane vs Mission Control AI synthetic workers | Homonym; context-dependent | [mc.builderz.dev](https://mc.builderz.dev/) vs [usemissioncontrol.com](https://usemissioncontrol.com/) |

### Manufacturing metaphors (Chatticus list + industry)

| Name | Usage | Fit | Notes |
| --- | --- | --- | --- |
| **Shop floor** | Metaphor in analyst/SEO writing | Weak as product name; evokes parallel workers | Often paired with "digital assembly line" |
| **Yard** (shipyard) | Chatticus synonym list | Weak in primary sources; concurrent work in one place | No major vendor primary page found under this name |
| **Reactor chamber** | Chatticus internal picture | Metaphor, not industry standard | Keep as Chatticus voice, not SEO target |
| **Agent org** | Occasional blog/startup copy | Vague; overlaps "agentic organization" HR sense | No dominant primary source |

### Gas Town role vocabulary (product-specific, not category nouns)

Yegge's stack exports a full fictional org chart: **Mayor**, **Refinery**, **Polecats**, **Witness**, **Deacon**, **convoys**, **molecules**, **hooks**. Useful as precedent for *named roles in a shared town*; not generic industry terms. See [Welcome to Gas Town](https://yegge.ai/essays/welcome-to-gas-town/).

## Chatticus naming (fixed points)

- **Agent Zoo** — the public **desk** covering this category on chattic.us. Not a synonym for the workplace inside the product.
- **Reactor chamber** — Chatticus's picture of the idea: stable place where agents collaborate and do useful work.
- **Do not** rename Chatticus bots, the computer, skills, routines, or worker protocol after third-party coinages (Gas Town rigs, Grok Bots, Droids, etc.).
- Existing synonym list in [`web/content/blog/AGENTS.md`](../blog/AGENTS.md) remains the editorial seed; this wiki note extends it with sourced usage.

## Editor shortlist

### Best fit for Agent Zoo voice (category labels)

Use when writing *about* the category without implying a Chatticus product rename:

1. **Software factory** — Factory.ai has made this the best-funded explicit name for an interconnected agent SDLC system.
2. **Multi-agent workplace** / **agent workplace** — Plain, accurate, no vendor lock-in; pair with "reactor chamber" for Chatticus color.
3. **Agent Command Center** / **control room** — Operator-surface metaphor when the story is *managing* parallel agents (Devin Desktop, Grok Bot participant accounts).
4. **Gas Town** / **workspace manager** — Open-source pole for git-backed multi-agent coding ops; cite Steve Yegge when naming the peer.
5. **Digital assembly line** — Enterprise and Google Cloud trend language for multi-step agent pipelines; good for "industry narrative" posts, less for Chatticus product docs.

### Useful but narrow (peer-specific)

- **Grok Bot** / **AI teammates** — xAI/Cursor product; "Bot" = one persistent named agent on a shared computer.
- **Crew** — CrewAI framework term; strong in developer audience, weak as end-user category name.
- **Agent teams** — Claude Code experimental; session-scoped, high token cost, not a hosted org.
- **Mission Control** — Say **builderz-labs** when meaning the open-source control plane.

### Avoid as Chatticus category voice

| Term | Reason |
| --- | --- |
| **Model zoo** | Pretrained-model catalog; collides with Agent Zoo desk name |
| **Bot farm** | Spam connotation |
| **Foundry** (unqualified) | Azure model platform |
| **Studio** | Playground UI |
| **Harness** / **runtime** / **agent OS** | Infrastructure layer, not the workplace |
| **Swarm** / **hive** (generic) | Overloaded; often means task fan-out or unrelated products |

## Open questions

1. **Will "software factory" stick?** Factory.ai owns the term in marketecture; Cognition still sells "autonomous engineer" and command center, not "factory."
2. **Does "AI teammate" become the consumer category word?** Grok Bot and Anthropic marketing ("give Claude real work") push teammate language; developer tooling still says agents, crews, and clouds.
3. **Where does the line fall between workplace and control plane?** Mission Control, Gas Town's `gt`, and Devin's Command Center blur operations desk vs execution environment.
4. **Is "digital assembly line" enterprise-only?** Strong in Google/manufacturing PDFs; rare in developer-first products.
5. **Anth.us / Tactus** — runtime and procedure stack for governed agents; no public "workplace" brand yet beyond participant essays on Grok Bot.
6. **Homonyms to watch:** Mission Control (two companies), Foundry (Microsoft vs metaphor), Agent Factory (Verint vs Microsoft tagline).

## See also

- [Agent workplace](agent-workplace.md) — short definition stub
- [Agent Zoo editorial guide](../blog/AGENTS.md)
