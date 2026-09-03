# Product

Chatticus is a roster of named AI teammates. You give a teammate a job. It
works in real tools. It only interrupts you for approval or a human-only
step.

The product workspace is [hey.chattic.us](https://hey.chattic.us) in
production. The public marketing site is [chattic.us](https://chattic.us).
Named bots on the product surface will use [Vultus](https://github.com/AnthusAI/Vultus)
(`anthus-vultus`), an animated React avatar, as their face. That is the
web app. It is not a second realtime transport.

## Bots

A bot is a persistent, named teammate:

- It has a name, a role, and durable memory.
- It keeps conversation, preferences, and summaries of prior work.
- Context compounds. It is not a fresh environment on every task.
- Several bots can run in parallel and hand work to each other.

Bots can message each other and pass ownership so the human is not the
router between tools. A **channel** is the conversation object: every bot
on it reads the whole channel, and only the addressed bot acts. Work
itself is tracked as issues; see [Tasks](TASKS.md). The channel model is
decided (a channel is the thread; `addressed_to_bot_id` enqueues a turn;
there is no second bus). How conversations compact over time has open
sub-questions; see [Design challenges](DESIGN_CHALLENGES.md).

## One computer per organization

Every bot in an organization uses the **same** computer:

- Browser cookies and signed-in sessions are shared.
- Files under `/workspace` are visible to every bot in that organization.
- Command-line credentials on that computer are shared.
- One bot can continue from files another bot saved.

The computer is isolated to the **organization**, not to an individual bot or
member. A login or file placed on the computer is available to every bot and
member in that organization. Do not treat separate bots as a security
boundary.

The computer is not tied to one physical box. A garage Mac, a Fargate
task, and a stop/start EC2 instance are **hosts**. They all run the same
workplace identity (`computer_id`). Durable `/workspace` files and the
browser profile live in an **S3 snapshot**. A host hydrates that snapshot
onto local disk, runs, and publishes before another host takes over. There
is no live container move. An administrator relocate is "publish, then
hydrate on this host." See [Computer snapshots](COMPUTER_SNAPSHOTS.md).

Each bot gets its own **screen** on that computer. Screens are separate work
surfaces, not separate security boundaries. One bot can run one computer-use
task on its screen at a time.

Ask bots to keep durable project files in `/workspace` with clear project
folders. Treat temporary directories, manually installed packages, and
uncommitted application state as replaceable.

## Bots, computer, and files are separate capabilities

Talking to a bot, running the computer, and reading or writing a shared
file are independently gated — not one bundle that comes up together:

- **model** — reasoning and any tool that doesn't touch the computer.
  Always ready.
- **workspace** — reading and writing `/workspace` files. A read serves
  straight from the published S3 snapshot even while no host has
  hydrated it (`read_workspace`); a write requires a host to have
  already loaded the live disk (`hydrate_required` is `False` — see
  `write_workspace`).
- **browser** — full computer-use automation (Xvfb, Chromium). The
  slowest gate to clear, and only needed for work that actually
  requires a browser, such as a site with no API.

See `capability_for_computer_tool` and `ComputerCapabilityReadiness` in
`computer_capabilities.py`. A bot never waits on the browser stack just
to touch a file, and reading one needs no host running at all — writing
still needs a hydrated host disk today, but not the browser.

This is expected to change: see [Computer manifold](COMPUTER_MANIFOLD.md)
for the proposed direction (EFS as a single, organization-wide filing
cabinet every bot and every computer reads and writes directly, instead
of each host hydrating its own copy from a snapshot). That direction is
not implemented and this section does not describe it as current.

## Tools versus the browser

Prefer a connector or MCP server when one exists. Structured tools are more
reliable than clicking through a website.

Use the computer's browser for services without a connector, or for visual
workflows a connector does not expose.

A site may still block automation, require a new login, present a CAPTCHA,
or require human confirmation. The bot should hand those steps to the human
rather than bypassing them.

Installed connectors are account-wide. Their availability is not isolated to
one bot.

## Skills and routines

A **skill** is a reusable set of instructions for how to do a task: when to
use it, required inputs and access, the sequence of work, how to validate
the result, what to return, and what requires approval.

A **routine** tells one bot when to run a workflow: on a schedule, or after
an event (for example a Slack message or a GitHub notification). Background
routines can run while the laptop is closed.

Start with a one-time task. Make it reliable. Save the method as a skill.
Only then automate it.

Teach-by-demonstration records visible computer interaction and turns it into
a draft skill. The draft still needs decision rules, failure handling, and
approval boundaries that may not be obvious from one example. Do not expose
secrets during a demonstration.

A useful routine states the owning bot, the schedule and time zone, the
input source, the expected result, the approval boundary, and what happens
when a source is missing. Include a no-data and stale-data policy. Make
retries idempotent where possible.

## Approvals and takeover

An approval controls a **proposed** action. It does not reverse work already
completed.

Keep behind approval:

- sending messages or invitations
- publishing content
- purchases and financial transfers
- deleting or overwriting data
- changing permissions
- production changes
- accepting legal terms

Auto-review rules can require approval, always allow, or never allow matching
actions. If both a require-approval rule and an always-allow rule match,
require-approval wins. Write narrow rules. Broad rules such as "allow
everything in the browser" are not acceptable.

For passwords, passkeys, two-factor codes, CAPTCHAs, payments, and identity
checks, the bot hands over the computer. The human completes only the blocked
step and returns control. Do not paste passwords or one-time codes into
chat. A supported connector may present a masked secret request that is not
added to the transcript and is not shown to the model.

## Local device versus the Chatticus computer

The Chatticus computer is the Linux workplace on a worker. The Mac or
Windows machine in front of the human is a different machine unless that
machine is also registered as a **host** of the computer (Docker worker
on the garage Mac). Hosting the computer is not the same as local-device
execution.

A bot runs commands on the local device only when that capability is
enabled and the human's local-device policy allows it. Default is ask every
time. Use never-allowed unless a bot has a specific reason to touch local
files.

## First handoff

A good first task involves several tools and a clear result: pull a list,
skip people already in a sequence, research the top accounts, draft messages
in the user's voice, and leave drafts to approve by morning.

The human reviews, corrects, and can turn the process into a skill or a
routine.
