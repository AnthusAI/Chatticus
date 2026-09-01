# Tasks

A **turn** is one model loop. A **task** is a job a human gave a bot,
which may span many turns, several approvals, an interruption, and a
night.

Chatticus had no object for that. Turns and messages could not say how
far a job got, whether it finished, or why it stopped. This document
records what task state must hold and where v1 stores it.

## The failure that matters

Agents fail visibly in ways that are merely annoying: a page changed, a
session expired, a CAPTCHA appeared. They also fail invisibly, and that
is what breaks trust.

Filled the form but never submitted it. Sent to the wrong recipient.
Updated seven of ten rows and reported "done." All three read identically
in a transcript: a confident sentence.

An agent that fails loudly is usable. An agent that reports success it
did not achieve is worse than no agent, because the human stops checking.

## The rule

> **Never trust the agent's account of what it did. Look at the world.**

"I sent it" is not evidence. A message identifier, an API response, a
row count, a screenshot of the sent folder is evidence. Completion
requires evidence produced by the system acted upon, not a claim by the
actor.

**A task may never reach a completed state without evidence.** If the
agent cannot produce evidence, the honest terminal state is blocked.

The same rule defends against prompt injection and makes retries
idempotent. See [Threat model](THREAT_MODEL.md).

## v1 decision

**v1 ships a thin Task item in Chatticus DynamoDB.** The agent tool
exposes status, evidence, close reason, and bot provenance. The same tool
interface can point at [Kanbus](https://github.com/AnthusAI/Kanbus) HTTP
later if its store ever matches; v1 does not wait for that.

**Rationale.** Channel compaction (challenge 3) summarizes old messages
into a tail-plus-summary view. Task progress that lives only in the
channel — "seven of ten rows done," "waiting on approval" — is lost when
those messages compact. A household runs for weeks; long jobs need
durable state outside the transcript. The architectural win is task state
off the channel, reachable at the first readiness gate without summoning
a computer, with evidence required to close. That needs a structured tool
and a few fields, not Kanbus table sharing or EFS in v1.

**What v1 does not do.** No Kanbus product integration, no shared
DynamoDB table with Kanbus, no filesystem project on the computer. A
later slice implements the Task item and tool; this slice records the
decision only.

## Structured task tool (not a computer action)

Task reads and writes need network and credentials. They need no browser,
no display, and no `/workspace`.

So the task tool sits in the **first readiness gate** alongside MCP servers and
connectors, and a turn running on a computerless worker can read, create,
comment on, and close tasks with **no computer summoned at all**. See
challenge 5 in [Design challenges](DESIGN_CHALLENGES.md).

That produces several things at once:

- Project management is a cheap turn. Status questions, assignments, and
  closes never boot a browser.
- Bot-to-bot coordination costs nothing. Two bots hand off through tasks
  without either needing a computer.
- Routines report without booting.
- **An agent can check its task before deciding whether to summon the
  computer.** Reading the task is free and tells the agent whether it
  needs a browser, which makes `start_computer` an informed decision
  rather than a guess. It also fills exactly the window requirement 16
  needs filled.

The interface is a **tool in the agent's tool list**, not a shell-out to
the `kanbus` binary. Shelling out to a CLI that expects a filesystem
project would drag the computer back in.

### Storage (v1)

Task rows live in the Chatticus DynamoDB table alongside channels and
turns. Both the agent tool and the control plane read the same items. No
projection, no sync, no snapshot coupling. Tasks are visible in the web
app with no computer running.

`tenant_id` belongs in the partition key, as everywhere else. A worker
registered to tenant A must never read tenant B's tasks.

The v1 Task item carries at minimum: status, evidence, close reason, and
bot provenance. Richer fields — priority, hierarchy, dependencies,
acceptance criteria — are out of v1 scope.

### Long-term: Kanbus HTTP

[Kanbus](https://github.com/AnthusAI/Kanbus) already models what richer
task management needs. If its cloud store later matches this shape, the
same agent tool can call Kanbus HTTP instead of Chatticus DynamoDB. v1
does not depend on Kanbus internals (shared tables or EFS-backed
projects). That integration is a later phase, not a v1 gate.

### Tasks and artifacts are different things

The task store holds task **state**. `/workspace` holds the **artifacts**:
the research notes, the drafts, the files. A task references a
`/workspace` path rather than copying bytes, exactly as a message does.

## Compaction can eat task state

Challenge 3 compacts a channel to "latest summary plus tail". If the fact
that accounts one through seven are done lives only in messages that were
summarized, a long task loses precision exactly when it needs it, and
summary-of-summary compounding makes it worse over weeks.

**Task state must not live only in the conversation.** The Task item, its
status, and its evidence live in structured rows outside the channel. The
conversation around them can compact freely.

This constraint was invisible until tasks and compaction were put side by
side. It is a reason to keep them in separate stores.

## Still open

- What "evidence" means per action class, and whether it can be enforced
  as a Kanbus policy rather than Chatticus code. Kanbus has policy-as-code
  and it looks like the right home, but it has not been read closely.
- Budgets. A task needs step, token, and wall-clock limits, with
  exhaustion as a real terminal state rather than a hang.
- Whether a Chatticus channel maps to a task, or whether the two stay
  orthogonal: conversation in channels, work in tasks.
- One task namespace per user, per bot, or per engagement.
- Stuck detection. No-progress loops burn money and time, and "am I
  making progress" is not answered by any current mechanism.
