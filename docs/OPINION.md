# Opinion: adversarial review of the Chatticus design

This file is **one reviewer's opinion**. It is not a design document, not a
decision, and not a challenge to replace. The design remains in
`DESIGN_CHALLENGES.md` and `MESSAGING.md`.

Written after reading `README.md`, `DESIGN_CHALLENGES.md`, `MESSAGING.md`,
`TASKS.md`, `THREAT_MODEL.md`, `FEASIBILITY_TESTS.md`, `ARCHITECTURE.md`,
`STACK.md`, and the in-memory kernel. The product is designed and not
built.

A first draft of this opinion treated scale-to-zero as a cost choice and
recommended dropping it for the control plane. **That was wrong.**
Requirement 7 stands. The findings below are re-derived with that as a
constraint.

---

## Overall

The product idea is coherent: named persistent teammates, one computer
per user, pull workers, approvals, tenant-aware from day one.

Scale-to-zero is a **requirement**. A proposal with an idle floor is
wrong no matter how much simpler it is. The per-request control plane,
DynamoDB, turn-scoped SSE, and no persistent sockets follow from that.
I no longer argue they should be abandoned.

What I still attack is load-bearing incompleteness inside that shape:
prompt injection as a claimed boundary, an escalation protocol with no
ownership, a kernel that still implements the rejected design, and a
documentation response to "we are documenting instead of building" that
was more documentation.

---

## Docs versus code: the response was not adequate

The diagnosis was right. The action was more documentation.

After naming the imbalance the repo added `FEASIBILITY_TESTS.md`, then
`TASKS.md`, `THREAT_MODEL.md`, the channel model, and the summoning
design. Tests 1 and 2 are still unrun. There is still no HTTP API, no
model loop, no computer agent, no web app.

The only executable protocol still implements the **rejected** design:

- `ControlPlane.post_message` always enqueues `frozenset({"computer"})`
  (`python/src/chatticus/control_plane.py`). Challenge 5 says many turns
  never need a computer.
- The kernel fans out in-process WebSocket-shaped events
  (`RealtimeSubscription`, `TurnStream`). Challenge 1 deleted both
  sockets and in-process rendezvous.
- There is no `turn_id`, no turn state, no computerless capability path.

`DESIGN_CHALLENGES.md` “How to work on this” still says “Challenge 4 is
open.” Challenge 4’s header says **Decided.** `PRODUCT.md` still says
channel storage “is not decided.” `README.md` still lists `MESSAGING.md`
as “sketch only.” The last design commit recorded decisions and did not
reconcile the files that tell an agent what to build.

Recording “run these two tests, then build the thin turn” was the right
response. Writing it down and then writing more design is the same
failure mode with a footnote.

---

## 1. Prompt injection: the load-bearing claim fails

**Claim.** `THREAT_MODEL.md`, Direction 1: “Page content is data, never
instruction. The agent loop must keep a durable separation between the
task it was given and the text it reads.”

**That is not achievable with current models as a boundary.** Instruction
hierarchy, delimiters, spotlighting, and “tool output is data” prompting
reduce hit rate. They do not produce a durable separation. Published
agent-injection evals still show material success against production
models. The model is the interpreter of the goal; you cannot enforce
“content cannot revise the goal” inside it.

Everything else in that document is written as if rule 1 were a control.
It is a mitigation that fails under adversarial input. The product then
maximizes blast radius around that failure: bots are not a security
boundary, connectors are account-wide, one shared browser profile holds
the user’s logged-in sessions, and that profile is snapshotted to S3 and
relocated.

**The approval rule is the actually useful idea, and it does not apply
to the product’s computer path.**

“Never trust the agent’s account. Describe the world. An approval card
must show the concrete operation as the target system would receive it”
works for a structured `send_email(to=, body=)` or `transfer(amount=,
dest=)`. It does not work for computer use. The target system receives a
click, a keystroke, or a navigation. An approval card that says “click
(412, 880)” or shows a screenshot the model chose is the agent’s framing
again. The document already admits an injected model writes the card’s
story; it does not admit that for browser actions there is no non-story
form of the operation.

That is the path the product itself says is the fallback for sites with
no API — email, docs, the sites a household actually wants a teammate to
drive.

**“That one rule covers three problems” is overstated.** Concrete args
help structured tools. Evidence of completion (`TASKS.md`) catches lying
after the fact. Neither stops exfiltration that already happened:
navigate to an attacker URL with data in the query, upload `/workspace`
to a form, a hidden image request, a “share” click. Egress is listed as
approval-class. If every navigation is an approval, the product dies of
fatigue (the doc already calls >90% approve-without-reading theatre). If
it is not, injection has a silent channel.

**What the system should do instead** — a demotion of rule 1, not a new
architecture:

1. Treat the model as hostile once it has read a page. Rule 1 stays as
   prompting. It is not a control.
2. Split ambient authority. The profile that drives untrusted pages must
   not carry high-value cookies. “Summonable sessions” is already listed
   as open in the threat model; it is not optional. One snapshotted
   mega-profile is the opposite of that.
3. Enforce egress and tool allowlists in the worker, from the **task**,
   not from the model. An injected “email /workspace to this address”
   should be a tool the current task did not grant. That is a system
   check.
4. Authenticated computer-use on consequential origins is human takeover
   or a structured connector. It is not model-click plus a card.
   Requirement 4 already says passwords are takeover; sending-as-the-user
   on a logged-in mail site is the same class of authority.
5. Do not snapshot a poisoned profile as the workplace. `THREAT_MODEL.md`
   “Known gaps” already names cookie persistence and has no answer.
   Until there is a reset/quarantine story, relocate spreads the
   compromise.

If v1 ships with one shared logged-in Chromium and “the model will treat
page text as data,” the first malicious calendar invite or email body
owns the household computer. Approvals will not save it on the browser
path.

---

## 2. The escalation seam

The protocol (`DESIGN_CHALLENGES.md` challenge 5):

> append the tool call → enqueue a computer job for the same turn →
> stop, transfer no state → computer worker reads the stream and
> continues.

There is no `Turn` object in the kernel. `TurnJob` has a `job_id` and no
`turn_id`. There is no lease, no fencing token, no idempotency key, no
orphan reaper, no job heartbeat. SQS is at-least-once. The following are
not edge cases; they are the protocol as written.

Because scale-to-zero is a requirement, these cannot be fixed by adding
an always-on process to hold a lock in memory. They have to be closed
with per-request primitives: a turn item with a conditional lease, an
idempotency key on enqueue, a start-lock per `computer_id`, a TTL or
EventBridge reaper, a visibility heartbeat on the SQS message. None of
that is specified. Until it is, the seam is not implementable without
inventing ownership on the fly.

**Duplicate turns.** Computerless worker appends, enqueues, then dies
before deleting the original SQS message (or the visibility timeout
expires because “it stops” is not specified as an ACK). A second
computerless worker pulls the same job, sees a computer tool in the
stream, escalates again. Two computer jobs, one `computer_id`, two
agents on one display. `COMPUTER_SNAPSHOTS.md` forbids two live disks
for one computer; the job path can still put two loops on one host.

`start_computer` is idempotent for the machine. Enqueueing the
continuation job is not described as idempotent. Speculative
`start_computer` plus implicit escalation plus SQS redelivery is three
computer jobs.

**Lost turns.** Append succeeds, enqueue fails: tool call sits in the
stream, nobody executes it. Enqueue succeeds, append fails: computer
worker reads a stream with no pending tool call and either stalls or
re-asks the model. There is no reaper. The turn hangs until a human
notices.

**Double-billed model calls.** “Reads the stream and continues the loop”
is ambiguous. If the computer worker replays the message list through
the model, it re-pays every pre-computer token and may emit a different
tool call than the one that triggered escalation. If it only executes
the last pending computer tool, parallel tool calls (one connector, one
browser) are unspecified: the computerless side may have run some and
left others.

**The hang that holds a browser.** After the first computer action the
turn is pinned to host-local state (live page, cwd, processes). Worker
dies mid-action: the stream cannot reconstruct the page. No orphan
reaper. Fargate keeps billing. Requirement 7 is then false in
production, because the platform cannot tell “working” from “wedged.”
`TASKS.md` lists stuck detection as open for tasks; it is missing for
**turns and computers**, which is where the money is. A scale-to-zero
system that cannot prove a turn is dead will bill forever. That is a
requirement 7 defect, not a cost quibble.

**The scheduler does not exist.** `assign_turn` picks a healthy
registered worker. That model assumes a long-lived process that
heartbeats. A scale-to-zero computerless worker (the only shape that
satisfies both requirement 16 and requirement 7) does not exist between
invocations, so it is never healthy, so computerless jobs never assign.

Cold computer path: enqueue a computer job, no host is up, “request a
Fargate start.” The control plane is per-request. Who notices the
waiting job? EventBridge-on-enqueue can `RunTask`. Nothing says “at most
one start per `computer_id`.” Two waiting jobs, two `RunTask` calls, two
hosts, two live disks — the split brain the snapshot doc says they will
not build. The missing primitive is a DynamoDB conditional start-lock
on `computer_id`, not an always-on scheduler.

**The sleeping Mac.** Household default: garage Mac, `prefer_local`. Mac
sleeps, heartbeat dies, failover hydrates Fargate from the last
snapshot. Morning the Mac wakes with a newer dirty local volume,
registers, and wins `prefer_local`. `COMPUTER_SNAPSHOTS.md` says
unpublished writes block *administrator* relocate. Failover on
heartbeat death does not mark `hydrate_required` on the Mac. First week
of real use.

---

## 3. Scale-to-zero is a requirement

I originally said a fresh reader should reject the control-plane
principle: the $25/month saving does not pay for the polling seam, and
the multi-tenant write-up is a false dichotomy (nobody multiplies a
process per tenant; they already share DynamoDB and SQS).

**That recommendation is withdrawn.** Requirement 7 is not a cost
optimisation. Non-requirement 2 already says a lower average bill with
an idle floor loses. Challenge 1 already says: adopt “nothing bills
while nobody is working” as a principle or not at all. The owner
confirms it is a principle. So the extra moving parts are mandatory,
and “one small always-on process” is not an allowed alternative.

What survives of the original attack is narrower:

- The *written justification* in challenge 1 still overclaims. “An
  always-on process multiplies that floor by the number of tenants, or
  forces tenants to share one process and take on the isolation problem
  that avoids” is not why requirement 7 is true. Requirement 7 is true
  because an idle floor is forbidden, including a shared $25 process.
  The isolation fork is a bad argument for a correct rule. If the
  premise is re-checked later, check the requirement, not that
  sentence.
- Because the requirement stands, the escalation holes in section 2
  are unfinished work the requirement imposes, not evidence the
  requirement is wrong. They have to be designed as scale-to-zero
  primitives before anyone builds the handoff.
- A hung turn that holds a computer is how requirement 7 fails in
  production. Idle-down and a turn reaper are not v2 polish. They are
  how the requirement stays true.

I do not recommend reopening challenge 1.

---

## 4. DynamoDB keys: what else you cannot cheaply do

Shape: PK `tenant#channel_id`, SK `seq`. GSIs `(bot_id, time)` and
`(user_id, last_activity)`. DynamoDB is the right store under
requirement 7. These are access patterns the key shape forecloses or
makes expensive, not an argument for a relational instance.

| Wanted later | Why it hurts |
| --- | --- |
| All channels in a tenant | Concatenated PK is not `tenant` then `channel`. Listing is the user GSI only. A household with more than one human is not modeled. |
| In-flight turns for a user | No turn table, no status index. Orphan reaping cannot be a query. The reaper section 2 requires needs this item and index. |
| Messages addressed *to* a bot | GSI is “everything a bot authored,” not `addressed_to_bot_id`. |
| “What happened last night” across channels | Fan-out to every partition, or a `(tenant, time)` GSI that hot-partitions. |
| Channel for this Kanbus issue | Left orthogonal in `TASKS.md`. No `issue_id` GSI. |
| Channels that need compacting | No “tokens since last summary” index. Nightly job walks the user GSI. Fine for one household. |
| Concurrent `seq` | Two live turns, two Lambdas. Monotonic `seq` needs a transactional counter on a channel item. Not specified. Duplicate or skipped `seq` breaks `after=seq` replay, which is the reconnect invariant. |
| Tenant isolation on the GSI | Challenge 2 says tenant belongs *inside* the key so isolation is structural. `(bot_id, time)` drops tenant. Guessable or colliding `bot_id` is a cross-tenant read. |

Full-text search was the right concession. The missing turn index and
the GSI tenant leak are the ones that matter before anyone asks for
search.

---

## 5. Kanbus

`TASKS.md`: “Chatticus should not start integration work until that
[cloud storage backend] lands.”

Kanbus cloud today is EFS-backed files plus Lambda
(`Kanbus/infra/cloud/README.md`). There is no DynamoDB issue store in
that repo. Chatticus wants to share a DynamoDB table: “No projection,
no sync.” That couples an unbuilt product to an unbuilt rewrite of
another product’s storage, and it couples their schemas forever.

The architectural win — task state off the transcript, reachable at the
first readiness gate, evidence required to close — does not need
Kanbus-the-database. It needs a structured tool and a few fields:
status, evidence, close reason, bot provenance.

**Fallback if that work stalls:** a thin Task item in Chatticus
DynamoDB with those fields. Point the same tool at Kanbus HTTP later if
their store ever matches. Waiting to start Chatticus integration is how
v1 ships with no task object, after the design already established that
compaction will eat task state.

Using Kanbus as an HTTP tool against EFS would also work and would not
violate “don’t invent a task object.” Sharing a table is the unwise
part. EFS as Kanbus’s store also has an idle floor; if Chatticus
routines depend on that store, requirement 7 is only as true as
Kanbus’s bill.

---

## 6. Lossy compaction

The store model is fine: originals stay, so you can always rebuild. The
default algorithm is not: every new summary is
`S_n = summarize(S_{n-1} + tail)`.

What degrades first is **precision of ongoing work** (already caught;
that is why tasks must not live only in the channel). Next: numbers,
names, paths, who promised what, why an approval was granted. After
enough generations the model view is a bland teammate that has lost the
household.

Unstated recovery path: periodically re-summarize from raw messages in
a window, and write durable facts into bot memory / the task store
*before* compact. If you only ever fold prose into prose, a year of
daily use will not hold. The human scroll will still be complete; the
bot will not be.

---

## 7. Requirement 16

For turns that never need a computer, requirement 16 is free: the first
word is the answer.

For turns that need the browser, generated text in the boot window is
almost never the work. Restating the plan, “I’ll start by…”, creating
an empty task — that is the empty-calorie paragraph users already
distrust. It makes the product feel like it is working when it is
waiting.

The design already has the honest signal: `turn.waiting` naming the
gate (`MESSAGING.md`). Use that. Do not spend a model call to hide a
boot.

Kanbus-in-the-window is useful only when a task already exists and
reading it changes whether to boot. A new “check my email” has no such
task. The useful first word is behind Chromium.

Requirement 16 as written does not distinguish these cases. As a
universal “must produce tokens immediately” it will produce filler,
which is worse than an honest wait.

---

## 8. Inversion miss

**A consequential action while nobody is at a screen has no completable
approval path.**

Requirement 3: work continues when the laptop is closed. Requirement 4:
consequential actions are gated. v1 is a web tab. Device push is
specified as “come back, something finished,” not “approve this now”
(`MESSAGING.md`). iOS is v3.

So either overnight work cannot include anything that matters (the
headline promise is false for send / purchase / publish), or auto-review
gets loosened so routines can finish unattended (the threat model
becomes theatre, and injection pays off at 2 a.m.).

The first-handoff example — draft overnight, approve in the morning —
is the honest v1. The documents do not say that the headline promise is
scoped to non-consequential work. That gap will get closed in
production by weakening approvals.

---

## Settled decisions: which premises fail

Do not re-derive the decisions. These recorded *reasons* are the ones I
still dispute. Scale-to-zero is not among them.

| Decision | Premise that fails |
| --- | --- |
| Challenge 1 justification text | Always-on multiplies cost per tenant, or sharing a process is a new isolation problem. The decision is correct because requirement 7 forbids an idle floor, including a shared one. That sentence is a bad reason for a good rule. |
| “Page content is data, never instruction” | Current models do not provide a durable task/content split under adversarial pages. |
| Escalation with “the stream is the handoff” and no lease | An agent loop’s message list is portable. Ownership of a live turn and a live display is not. SQS plus two worker classes without fencing does not preserve “one turn, one actor.” Fix it with scale-to-zero primitives, not an always-on process. |
| No persistent sockets anywhere | Watch/takeover is an outbound display tunnel through the control plane (`ARCHITECTURE.md`). That is a long-lived binary stream. Requirement 4’s password path needs it. Lambda-plus-SSE does not carry a display. The turn-scoped version is not specified. |

SSE over WebSocket, and “a stream is one turn,” remain the right shapes
under requirement 7.

---

## Feasibility tests — flags only

**Test 1.** AWS documents response streaming as first-class on **Node**
managed runtimes. Python needs a custom runtime or the Lambda Web
Adapter. The stack is Python. CloudFront origin read timeout defaults
to 30s, standard max 60s, hard max 180s (quota). A 15-minute Lambda
hold through CloudFront will not happen; reconnect-at-timeout is the
real path, and 30–60s is a normal turn. CloudFront TTFB on function
URLs has been reported in the 500–800 ms range even with caching
disabled. Function URLs plus `Content-Encoding` have produced 502s
behind CloudFront; the known workaround is stripping `Accept-Encoding`
at the edge. API Gateway HTTP API will not hold a minutes-long SSE
stream. Measure function URL direct vs CloudFront, as written; treat
**timeout and Python streaming**, not just buffering, as the likely
failures.

**Test 2.** Chromium is not in the image yet; already noted. The number
that will move is snapshot size after a real profile has lived for a
month, not the empty-image pull. Do not treat the first five cold
starts as the duty-cycle number.

---

## What I would do next

Not another design pass on challenges 1 and 2.

1. Specify the scale-to-zero ownership primitives the escalation seam
   is missing: turn item, conditional lease, enqueue idempotency,
   `computer_id` start-lock, reaper. Without those, challenge 5 is not
   buildable.
2. Run Test 1. The cloud API is decided and unmeasured.
3. Build the thin computerless turn: human message, DynamoDB, one model
   call, streamed chunks, one committed message. That is the smallest
   thing that is actually Chatticus. The kernel should stop encoding
   the rejected transport on the way.

The next useful artifact is that turn, not another section of
`DESIGN_CHALLENGES.md`.
