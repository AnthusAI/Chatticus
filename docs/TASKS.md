# Tasks

A **turn** is one model loop. A **task** is a job a human gave a bot,
which may span many turns, several approvals, an interruption, and a
night.

Chatticus had no object for that. Turns and messages could not say how
far a job got, whether it finished, or why it stopped. This records the
decision to use Kanbus for it.

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

## Kanbus is the task store

Chatticus uses [Kanbus](https://github.com/AnthusAI/Kanbus) rather than
inventing a task object.

It already provides what was needed: status, priority, an
initiative-epic-task hierarchy, dependencies, comments, acceptance
criteria, and a close reason. It also carries structured **agent
provenance** on every comment, so "which bot did this" is answerable,
which is the substrate bot-to-bot collaboration needs.

Its compaction model is the one this project independently arrived at:
append a summary, never rewrite the history.

### Kanbus is a structured tool, not a computer action

This is the part that matters architecturally. Kanbus needs network and
credentials. It needs no browser, no display, and no `/workspace`.

So it sits in the **first readiness gate** alongside MCP servers and
connectors, and a turn running on a computerless worker can read, create,
comment on, and close issues with **no computer summoned at all**. See
challenge 5 in [Design challenges](DESIGN_CHALLENGES.md).

That produces several things at once:

- Project management is a cheap turn. Status questions, assignments, and
  closes never boot a browser.
- Bot-to-bot coordination costs nothing. Two bots hand off through issues
  without either needing a computer.
- Routines report without booting.
- **An agent can check its task before deciding whether to summon the
  computer.** Reading the issue is free and tells the agent whether it
  needs a browser, which makes `start_computer` an informed decision
  rather than a guess. It also fills exactly the window requirement 16
  needs filled.

The interface is a **tool in the agent's tool list**, not a shell-out to
the `kanbus` binary. Shelling out to a CLI that expects a filesystem
project would drag the computer back in.

### Storage

Issues live in DynamoDB, one Kanbus project per Chatticus user, and both
the agent and the control plane read the same table. No projection, no
sync, no snapshot coupling. Tasks are visible in the web app with no
computer running.

`tenant_id` belongs in the partition key, as everywhere else. A worker
registered to tenant A must never read tenant B's issues.

This requires a cloud storage backend that Kanbus does not yet have. It
is filed there as the "Cloud storage backend for Kanbus" initiative.
Chatticus should not start integration work until that lands.

**Fallback if that work stalls.** The architectural win — task state off
the transcript, reachable at the first readiness gate, evidence required
to close — needs a structured tool and a few fields, not
Kanbus-the-database. If the cloud storage backend does not land, ship a
thin Task item in Chatticus DynamoDB (status, evidence, close reason, bot
provenance) and point the same tool at Kanbus HTTP later if its store
ever matches. Waiting to start Chatticus integration is how v1 ships
with no task object after this document already established that
compaction eats task state. Decide the fallback before v1 scope is set,
not after.

### Tasks and artifacts are different things

Kanbus holds task **state**. `/workspace` holds the **artifacts**: the
research notes, the drafts, the files. An issue references a `/workspace`
path rather than copying bytes, exactly as a message does.

## Compaction can eat task state

Challenge 3 compacts a channel to "latest summary plus tail". If the fact
that accounts one through seven are done lives only in messages that were
summarized, a long task loses precision exactly when it needs it, and
summary-of-summary compounding makes it worse over weeks.

**Task state must not live only in the conversation.** In Kanbus it does
not: the issue, its status, and its comments are structured rows outside
the channel. The conversation around them can compact freely.

This constraint was invisible until tasks and compaction were put side by
side. It is a reason to keep them in separate stores.

## Still open

- What "evidence" means per action class, and whether it can be enforced
  as a Kanbus policy rather than Chatticus code. Kanbus has policy-as-code
  and it looks like the right home, but it has not been read closely.
- Budgets. A task needs step, token, and wall-clock limits, with
  exhaustion as a real terminal state rather than a hang.
- Whether a Chatticus channel maps to an issue, or whether the two stay
  orthogonal: conversation in channels, work in issues.
- One Kanbus project per user, per bot, or per engagement.
- Stuck detection. No-progress loops burn money and time, and "am I
  making progress" is not answered by any current mechanism.
