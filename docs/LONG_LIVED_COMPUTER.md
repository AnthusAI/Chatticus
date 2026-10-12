# Long-lived computer, file protocol and preview

> **Status:** PROPOSED. Nothing on this page is built. It is a design for the
> step after [Pi session handoff](PI_SESSION_HANDOFF.md). Every statement about
> today's system carries a `file:line` reference into `origin/develop` at the
> time of writing; every statement about the proposal is labelled PROPOSED or
> ASSUMPTION. Section 12 lists what could not be verified.

Three diagrams go with this page. Open each file in a browser; they are
standalone pages and need no server.

| Diagram | What it shows |
| --- | --- |
| [Proposed architecture](diagrams/long-lived-computer/proposed-architecture.html) | Browser, CloudFront, Front Door, the queues, the Lambda executor, the starter, the long-lived owner, the snapshot, the table and the preview path |
| [A turn delivered to a live owner, then idle shutdown](diagrams/long-lived-computer/turn-to-live-owner.html) | Park, poll, per-turn credentials, serve, quiet publish, idle timeout, stop |
| [One preview request](diagrams/long-lived-computer/preview-request.html) | The browser to the dev server and back with every trust boundary and check marked |

## 1. Summary (plain English)

**What the person asked for.** See the files and folders the bot is working on.
Eventually see a running web page the bot started, in a browser tab inside
Chatticus. Have the computer stay on after a turn and switch itself off when
nobody is using it. A way for Chatticus itself to read and edit the files the bot
makes.

**What happens today.** The computer is started for one turn. It does that turn,
saves its disk to S3 and switches off
(`computer/host/src/owner-main.ts:59-103`). The next message starts it again,
which takes about 30 seconds. Nothing can look at the files in between, because
the files live on a machine that is off, inside one compressed archive.

**What this design proposes.**

1. The computer stays on after the turn and serves the organization's later turns.
   It switches off after 15 minutes without use (the exact number is a decision
   below). A second message a few minutes later is answered in seconds, not 30.
2. A new turn reaches a computer that is already on by **asking, not by being
   told**. The computer calls the control plane every second or so while it is
   busy and every ten seconds when it is idle: "any work for me?" This keeps every
   rule in `AGENTS.md`: no socket, no inbound port, nothing reaches into the
   computer. Polling costs about 0.03 cents an hour at the slow rate.
3. The credentials the computer holds are no longer fixed at start. A small
   program on the computer (the supervisor) holds only access to the organization's
   disk snapshot. For each turn the control plane hands it a separate, short-lived
   key that reaches only that bot's own conversation. Keys are renewed on request,
   and the whole computer is replaced after at most 8 hours.
4. Looking at files works in two modes. When the computer is off, Chatticus reads
   the last saved snapshot straight from S3, using a small index file saved next to
   the archive so one file can be fetched without downloading everything. When the
   computer is on, the request goes through the computer itself (again by being
   asked for: a file request is picked up on the next poll), which reads the real
   disk. Edits use "change this file only if it still looks the way I last saw it",
   so the person and the bot cannot silently overwrite each other, and every edit is
   written to an audit log.
5. The preview is a **relay over the same asking channel**. The browser talks to a
   separate web address, never to the Chatticus site, so a bot-written web page
   cannot reach the person's login. A relay program receives the browser's request,
   leaves it in a store, the computer picks it up on its next poll, makes the
   request to the dev server on the computer's own loopback, and leaves the answer
   in the store. It is slower than a direct connection (a page load takes seconds
   and a heavy one tens of seconds) but needs no open port, no load balancer and no
   WebSocket.
6. Because there is no WebSocket, "hot module reload" does not work. The preview
   reloads the page itself when files change. That is the honest cost of keeping
   the rules; Sections 8.2 and 8.4 price the alternative.

**Cost.** A computer costs about 1 cent an hour (1.5 cents with its public IPv4
address). A typical day of six work bursts with a 15 minute idle timeout costs
about 2.5 cents per organization, against about 0.8 cents today. The most a
computer can ever cost, if it never switched off, is about 24 cents a day.
Section 9 has the table.

**Biggest risks.** Memory (a dev server does not fit in 512 MiB, and the snapshot
code builds the whole archive in memory), the preview relay's page-load time for
unbundled dev servers, and unverified browser behaviour of embedding a preview
under the development site's isolation headers. Section 12.

## 2. Decisions needed from the owner

Each is a question, with my recommendation. Sections 6 to 8 give the options.

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | **Rule reading.** Requirement 7 says "no component has an idle floor" ([Design challenges](DESIGN_CHALLENGES.md), requirement 7). Is a computer that stays on for a bounded idle timeout after use acceptable? | Yes. A timeout is a bounded tail that ends on its own, not a floor. Keep a hard maximum lifetime so it can never become one. |
| D2 | Idle timeout default? | 15 minutes. Cost table in Section 9 covers 5, 15, 30 and 60. |
| D3 | Maximum owner lifetime, and credential renewal versus a one-hour cap? | Renewal, with a hard cap of 8 hours. A one-hour cap would restart the computer hourly and kill dev servers and previews. |
| D4 | How does a turn reach a live owner? | The owner polls a Front Door route (adaptive 1 s / 3 s / 10 s). Not a per-computer SQS queue, not a push to the owner. |
| D5 | Turns on one computer at the same time? | One at a time first, two later after resizing to 1 vCPU and 2 GiB. A waiting turn shows "waiting for the computer" (the existing waiting state). |
| D6 | Does a running dev server keep the computer awake? | No, by itself. An open preview tab does (its keepalive counts as activity). A sleeping computer shows "Wake". |
| D7 | Snapshot format: change to per-file gzip members plus an index, with default exclusions (`node_modules`, build output, caches)? | Yes to both. Without exclusions a dev workspace will not fit the 512 MiB owner. Cost: the agent reinstalls dependencies after a cold start. |
| D8 | Who may read and write files through the web app? | Every enabled organization member may read and write. Secret-looking files are masked and need an explicit "reveal" that is audited. Deleting and moving files wait for a later phase and need the owner role. |
| D9 | How does a person edit a file? | Directly, with an optimistic hash check and an audit record. Not as a hidden chat message to the bot. A separate "Ask Pi to change this" button sends a normal chat message. |
| D10 | **Rule decision.** May a load balancer exist only for the preview path? | No. About 16 dollars a month per environment (about 49 dollars for three) of idle floor to buy WebSocket pass-through, against a typical computer cost of about 1 dollar a month. Use the relay. |
| D11 | **Rule decision.** May the preview carry a WebSocket for hot reload? | No. Live reload by page refresh. Revisit only if D10 is answered yes. |
| D12 | Preview origin? | A dedicated registrable domain (not a subdomain of `chattic.us`), with a wildcard certificate and one random hostname per preview session. The hostname is the capability. |
| D13 | Default task size? | Keep 0.25 vCPU / 0.5 GiB until Phase 4, then 0.5 vCPU / 1 GiB. Offer 1 vCPU / 2 GiB per computer. No automatic resize yet. |
| D14 | Audit retention for user file edits and secret reveals? | 90 days in the table, then expire. |
| D15 | Should the owner's start credentials leave the ECS task description? (This closes review finding 3.) | Yes: pass a one-time bootstrap token in the task overrides and exchange it for real credentials on the first poll. |

## 3. The problem

Chatticus runs a bot's turn in a Lambda until the model calls a computer tool.
Then it parks the turn, starts a Fargate task that runs a Pi owner, and the owner
finishes the turn and exits ([Pi session handoff](PI_SESSION_HANDOFF.md)). Three
things follow that the person has now told us they dislike:

1. **Every computer turn pays a cold start.** The measured median time to
   ECS `RUNNING` is 22 seconds ([Design challenges](DESIGN_CHALLENGES.md), section
   5, "Measured 2026-08-31"), and the owner then hydrates the snapshot.
2. **Nobody can see the work.** The files exist only on a machine that is
   usually off, and then only inside `snapshot.tar.gz`
   ([Computer snapshots](COMPUTER_SNAPSHOTS.md)). The web app shows tool cards,
   which carry the paths the bot touched, and nothing else.
3. **A dev server cannot outlive the turn.** `run_terminal` runs a command to
   completion (`conversation/src/pi/local-computer-tools.ts:57`, a 600 second
   timeout); the task exits when the turn ends.

## 4. What exists today

Verified in the code. Paths are relative to the repository root.

### 4.1 The owner serves exactly one turn

- The container entry point reads one takeover job from its environment, runs it
  and returns an exit code (`computer/host/src/owner-main.ts:59-103`). The job
  source yields its job once and then null
  (`computer/host/src/owner.ts:51-63`).
- `takeOverTurn` prepares the turn, resumes it if parked, and calls `executeTurn`,
  which claims the turn with a new attempt and opens the Pi session under a new
  fence (`conversation/src/turn/computer-owner.ts:5-8,69-111`).
- `runOwnerOnComputerDisk` hydrates, runs the turn, then in `close()` publishes the
  disk if it changed and reports the computer stopped
  (`computer/host/src/owner.ts:279-332`, publish at `:295`, stopped at `:302`).
- A turn that ends `done`, `failed`, `parked`, `yielded` or `already_finished` exits
  0 (`computer/host/src/owner.ts:341-343`).

### 4.2 Start, lease, generation

- A parked turn publishes a start job only when no healthy host serves the
  computer: `ensureHostForParkedTurn` returns without a job when `assignTurn`
  finds one (`conversation/src/turn/park.ts:113-140`, the early return at `:126`).
- `assignTurn` treats a stopped computer as having no host
  (`conversation/src/domain/workers.ts:239`) and a worker as healthy only while its
  heartbeat is newer than 30 seconds (`workers.ts:24`). The owner heartbeats every
  10 seconds (`computer/host/src/heartbeat.ts:20-23`).
- The starter asks `requestComputerHostStart`, which shares an unexpired 60 second
  start lease or claims the next generation by compare-and-set
  (`conversation/src/domain/computers.ts:27,226-263`). It does not itself check
  that a live owner exists; it relies on its callers not publishing a job. That
  matters in Section 6.4.
- A stopped report releases the start lease of that generation and immediately
  starts owners for turns parked behind it
  (`conversation/src/http/host.ts:119-125`). An owner may report stopped only for
  the generation its token names (`host.ts:107-114`). This is the TS-70 behaviour
  (commit `5e9456c2`, "a stopped computer has no live host, so a parked turn
  starts one at once"). I could not find what TS-61 refers to without reading the
  Kanbus board, which the project rules forbid; see Section 12.
- A host that vanished is settled by `settleComputerIfHostLost`: no heartbeat
  within the timeout means the record is marked stopped and the live disk is to be
  rebuilt from the last snapshot (`computers.ts:190-208`).

### 4.3 Credentials

- The starter mints two tokens (gateway and owner-host audiences) bound to tenant,
  bot, turn, owner id and start generation, valid 3600 seconds
  (`conversation/src/computer/owner-start-driver.ts:28,141-154`), assumes the
  scoped role with five session tags tenant, bot, channel, computer and turn
  (`owner-start-driver.ts:155-176`), registers the owner as a worker
  (`:183`), and puts everything in the RunTask container overrides
  (`:188-218`).
- The role's static policy is written with the tags, so the credentials reach only
  one conversation session (`conversation/src/gateway/owner-role-policy.json`;
  the S3 session prefix and the Dynamo leading keys use the `bot` and `channel`
  tags). The role's maximum session is 3600 seconds
  (`infra/lib/computer-host-start.ts:23`).
- The owner may call exactly five host routes with its token
  (`conversation/src/http/owner-host-auth.ts:23-29`), and only while no other owner
  holds the turn (`:134`).
- Nothing renews any of it ([Pi session handoff](PI_SESSION_HANDOFF.md), Limits,
  "No refresh").

### 4.4 Snapshot

- One gzip tar of `workspace/` and the browser profiles, packed into a single
  in-memory `Buffer` (`conversation/src/snapshot/pack.ts:95-125`), uploaded as one
  object next to `manifest.json` (`conversation/src/snapshot/s3.ts:19-40`).
- To decide whether a publish is needed, the host packs the whole disk and compares
  the checksum (`computer/host/src/disk-lifecycle.ts:71-76`).
- A read of one file means downloading and unpacking the whole archive. There is no
  per-file index.

### 4.5 Network and sizes

- The computer's VPC has public subnets and no NAT gateway
  (`infra/lib/computer-stack.ts:49-58`), the security group has no inbound rules
  (`:138-142`), and tasks start with a public IPv4 address
  (`conversation/src/computer/host-starter.ts:181`). The owner task is 256 CPU
  units and 512 MiB, ARM64 (`computer-stack.ts:115-128`), with an empty task role.
- The Front Door is a Lambda with a streaming Function URL, 512 MB, 900 seconds,
  authentication type NONE (`infra/lib/control-plane-stack.ts:216-224,264-267`).
  CloudFront forwards `/api*` to it with a 60 second origin read timeout and a
  900 second completion timeout (`infra/lib/web-stack.ts:139-150`). The owner calls
  the Function URL directly (`CHATTICUS_FRONT_DOOR_URL`,
  `control-plane-stack.ts:317`).
- On the development site CloudFront sets `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
  (`infra/lib/web-stack.ts:104-113`, enabled only for development at
  `infra/lib/environments.ts:77-81`). That affects embedding a preview
  (Section 8.5).

### 4.6 The shell and the file tools

- Model-chosen commands run as uid 2000 through `chatticus-shell`, no capabilities,
  no new privileges (`computer/chatticus-shell`).
- The three file tools run a helper through that same launcher, so a link planted
  in the workspace gets the shell's reach and no more
  (`conversation/src/pi/owner-file-helper.ts:1-17`). The helper supports `read`,
  `write`, `stat` and `realpath` and refuses any final location outside the
  allowed roots (`:30-31,62-85`). This closes finding 1 of the security review
  (symlink escape). It has no directory listing and no ranged read.

### 4.7 How the web app consumes a turn

- The browser holds its sign-in tokens in `localStorage`
  (`web/lib/auth.ts:236`) and sends them as an `Authorization` header on a
  `fetch` (`web/lib/sse.ts:20-35`), not as cookies. A page on the same origin could
  read them. This is why a preview must never share the app's origin.
- Tool events already carry paths: `tool.call` for read, write and edit keeps
  `path` up to 500 characters (`conversation/src/turn/tool-event-fields.ts:12,131-145`).
  The activity model maps tool names to cards (`web/lib/turn-activity.ts:57-64`).

## 5. Requirements and non-requirements

Taken from [Design challenges](DESIGN_CHALLENGES.md); numbers are its numbers.

**Requirements this design must satisfy.** 7 (nothing bills while nobody is
working), 8 (a person watching a turn sees it progress), 10 (the stream is
re-derivable from the store), 12 (workers pull; the control plane never reaches
into a worker; no inbound ports), 14 (one image runs on Fargate, EC2 and local
Docker), 15 (the web app talks only to the control plane, never a worker), 16 (a
bot answers while its computer boots).

**Non-requirements this design leans on.** 1 (no token-by-token delivery: chunks
of a few hundred milliseconds are enough, so request-sized latency is acceptable
for file and preview traffic), 3 (first computer action may be slow), 4 (no
throughput), 5 (no duplex channel), 6 (no live updates in a tab with no turn
running), 14 (seconds of lifecycle latency are fine).

**Where a request conflicts with a standing rule.**

| What would be nice | Rule | Recommendation |
| --- | --- | --- |
| Hot module reload over WebSocket | No WebSocket, browser or worker side (AGENTS.md, "The cloud API") | Keep the rule. Reload by refresh. |
| A load balancer in front of the preview | No load balancer in front of the API; requirement 7 | Keep the rule; present as D10. |
| A live socket from the control plane to the long-lived owner | No persistent sockets; requirement 12 | Keep the rule. Poll. |
| An owner that stays up | Requirement 7 (idle floor) | Allowed as a bounded tail, D1. A hard maximum lifetime and an independent watchdog (Section 6.8) prevent a floor. |
| A stream that outlives a turn (for file or preview events) | A stream is scoped to one turn | Keep the rule. Short request/response only. |

The rule text also says SQS and EventBridge are not in the token path
(AGENTS.md; [Messaging](MESSAGING.md), "What the cloud API is not"). Dispatching a
turn to an owner is not token traffic, so SQS is not forbidden for it by that rule.
It is rejected in 6.1 for a different reason: per-computer queues would be
created at run time, and AWS resources exist only as CDK.

## 6. The long-lived owner (PROPOSED)

### 6.1 How a new turn reaches a live owner

Today a turn that parks while a healthy owner exists publishes nothing
(`park.ts:126`) and waits behind it; nothing wakes it until the owner exits and
reports stopped (`host.ts:124`). A long-lived owner needs a way to learn about
work.

| Option | How | Latency | Cost per live owner | Verdict |
| --- | --- | --- | --- | --- |
| **A. Poll a Front Door route** | Owner calls `POST /orgs/:tenant/host/owner/poll` on an adaptive interval; the route also counts as the heartbeat. The response lists dispatches (turn, bot, channel), file requests, preview requests, and a `drain` flag. | 0 to interval; average half | About 0.00027 USD/h at 10 s, 0.0009 at 3 s, 0.0027 at 1 s, 0.0054 at 0.5 s | **Recommended** |
| B. Long-poll inside the Function URL | Same route, held open up to 900 s | Near zero | Lambda bills wall clock: 512 MB held continuously is about 0.024 USD/h, 2.4 times the Fargate task | Rejected on cost (shape is fine) |
| C. Lambda pushes by HTTP to the owner | Needs inbound to the task, a known public IP, a security group opening ports to every Lambda address | Lowest | Free | Rejected: requirement 12, `computer-stack.ts:138-142`, finding "owner security group has no ingress" |
| D. A queue per computer that the owner reads | SQS long poll | Near zero | Cents per month | Rejected: queues created per organization at run time break "AWS only through CDK"; a shared standard or FIFO queue cannot be consumed by one chosen owner |
| E. Owner reads DynamoDB itself | Query the action items with its scoped credentials every second | Interval | About 0.00045 USD/h at 1 s | Viable and cheaper, but it widens the supervisor's direct table access and skips the control plane's checks. Keep as an optimization if poll cost ever matters |

Cost basis for A: a warm Front Door invocation of about 25 ms at 512 MB plus three
DynamoDB read units is about 0.00000075 USD per poll (ARM Lambda GB-second price
and on-demand read price, ASSUMPTION: prices not re-verified in this session; see
Section 12).

**Adaptive cadence (PROPOSED).** 1 s for 60 s after any activity, 3 s until 5
minutes after, 10 s beyond. 0.5 s while a preview or a file view is open (the
server returns `next_poll_ms`). The 10 second floor equals today's heartbeat
interval, so idle polling adds no calls: the poll replaces the heartbeat
(`heartbeat.ts:23`).

**What a parked turn does with a live owner.** The tool call parks exactly as
today (`park.ts:209-242`). The poll handler asks "which parked turns wait on this
computer's open actions?", which is `startOwnerForParkedTurns`' own query
(`park.ts:153-163`) used for a different purpose. For each, it returns a dispatch.
The owner calls `takeOverTurn` unchanged (`computer-owner.ts:69`). The turn claim,
the fence, the action ledger and recovery do not change.

**The first word is unaffected.** The Lambda still runs the pre-computer part
(requirement 16). A later optimization (Phase 5) lets admission send a turn
straight to a warm owner and skip the Lambda hop; it is not needed first.

### 6.2 One turn at a time, or several

The disk is one shared tree by design (the computer is organization-scoped;
bots are not a security boundary, non-requirement 11). Two Pi sessions can run
in one container: each has its own session, claim and fence.

Constraints: 512 MiB holds the supervisor, one Pi session and a gzip buffer; a
second session is untested (ASSUMPTION: no measurement exists). A turn waits at
most 15 minutes for its computer before it fails "computer unavailable"
(`conversation/src/turn/probes.ts:18`), and a single command may run 600 seconds
(`local-computer-tools.ts:57`), so strict serial service can fail a second turn
behind a long first one.

**Recommendation.** Serve one turn at a time in Phase 2 (smallest change, matches
today's invariant "one owner, one turn"). Run each turn in its own child process
so concurrency becomes a number, not a rewrite. Raise it to two when the task is
1 vCPU and 2 GiB and a measurement shows it fits (Phase 5). Until then the second
turn shows the existing waiting state.

### 6.3 Process layout inside the container

```
PID 1  entrypoint -> supervisor (root, Node)
  |-- credentials for the computer only (snapshot prefix, own heartbeat)
  |-- poll loop, idle timer, snapshot publisher, process table, local IPC socket
  |-- per-turn child (root, Node)  env: that turn's tokens and credentials only
  |       Pi session, tools, file helper started through chatticus-shell
  `-- background processes (uid 2000 through chatticus-shell)
          dev servers, watchers; log files outside /workspace
```

- The supervisor owns long-lived state. A per-turn child is forked for each
  dispatch with only that turn's secrets in its environment and exits when the turn
  ends. A crash or runaway in a turn takes down that child, not the computer.
- Background processes are started by the supervisor, not by the turn child,
  so they outlive the turn. They run as uid 2000 through the same launcher, with
  the same scrubbed environment. Their output goes to a ring file under
  `/var/log/chatticus/` (root-owned, outside the workspace), so the shell cannot
  rewrite its own logs and the snapshot does not carry them.
- A local Unix socket (`/run/chatticus/supervisor.sock`, mode 0600, root) is how a
  turn child asks the supervisor to start, stop or list processes. The supervisor
  opens no TCP port. The shell (uid 2000) cannot open the socket.
- Per-turn working directories: none. The workspace is one shared tree on
  purpose. A scratch `/tmp/turn-<id>` is available and is not snapshotted.

**Killing a runaway.** The launcher writes a high `oom_score_adj` for the
processes it starts, so the kernel's out-of-memory killer picks shell processes
before the supervisor (ASSUMPTION: the launcher runs as root before it drops
privileges and can raise a child's score; to be tested). The supervisor also reads
container memory use and, above 85 percent, stops the largest background process
tree and says so in the log (`owner_memory_pressure`). A command still ends at
its own timeout (`local-computer-tools.ts:57`).

**Memory and when to resize.** Rough planning numbers, ASSUMPTION: not measured.

| Workload | Likely resident memory | Fits 0.5 GiB | Fits 1 GiB | Fits 2 GiB |
| --- | --- | --- | --- | --- |
| Supervisor plus one Pi turn | 200 to 350 MiB | yes, tight | yes | yes |
| Static file server or a bundled app server (a Kanbus-console-like binary) | 20 to 100 MiB | with the above, tight | yes | yes |
| Vite dev server | 150 to 400 MiB | no | tight | yes |
| Next.js dev server | 500 to 1000 MiB | no | no | tight |

Two turns at once add another Pi session. Hence D13: small until Phase 4, then
0.5 vCPU and 1 GiB, with 1 vCPU and 2 GiB selectable per computer. Fargate cannot
resize a running task; a size change is stop (publish), start. Automatic resizing
on out-of-memory is deliberately cut (Section 11).

**The snapshot code must change first.** `packLiveDisk` buffers the whole archive in
memory (`pack.ts:100-125`) and the publish check packs the disk twice
(`disk-lifecycle.ts:71-76`, then `snapshot/host.ts:89`). A `node_modules` tree is
hundreds of megabytes. The new snapshot format (6.6) streams, excludes build
directories, and detects change by scanning file sizes and times instead of
packing.

### 6.4 Idle timeout, shutdown, and the lease and generation rules

**Activity** resets the idle clock: a turn dispatched or finished, a tool call, a
file request, a preview request, a preview keepalive from an open tab. A running
background process alone does not (D6).

**Shutdown sequence (PROPOSED).**

1. The idle clock reaches the timeout. The owner stops accepting dispatches
   locally and calls `POST /host/owner/stop-request` with its generation and the
   reason.
2. The control plane approves only if it sees no open requested action, no pending
   dispatch, no pending file or preview request and no live preview session for the
   computer. Otherwise it answers "work pending" and the owner resumes (no lost
   wake-up).
3. On approval the owner kills background processes (SIGTERM, five seconds,
   SIGKILL), publishes the snapshot if changed, and calls the existing stopped
   report with its generation (`host.ts:103-133`). That report already releases the
   start lease and starts owners for turns parked in the meantime (`host.ts:121-124`).
4. Exit code 0.

**Invariant kept from today.** A new owner never starts before the old one has
published and reported stopped, except when the old owner's heartbeat is lost for
30 seconds (`workers.ts:24`; `computers.ts:190-208`). I deliberately do **not**
treat "stop requested" as "no host" in `assignTurn`: that would let a park-time
start job race the final publish and hydrate an older snapshot. A turn that parks
during the final publish waits seconds, then the stopped report starts the next
owner.

**A hole that long-lived owners open: the start lease.** The lease is 60 seconds
(`computers.ts:27`). With one-turn owners a redelivered or late start job after
the lease expired would start a second host for a few minutes at worst. With an
owner that lives for hours, a stale start job from the queue (`ComputerStartJobs`
visibility is 360 seconds, `control-plane-stack.ts:123`) or a probe-driven re-ask
could claim a new generation while a healthy owner serves the computer, producing
two live disks. PROPOSED fix: `handleComputerStartJob` checks for a healthy owner
(same predicate as `assignTurn`) before it asks for a generation, and acknowledges
the job as `already_serving`. Add a Gherkin scenario. This is the single most
important correctness change in Phase 2.

**Stopped flag and generation.** Unchanged in meaning. The owner's token carries
its start generation; every state-changing route continues to compare it with the
record (`host.ts:107-114`). A computer record gains PROPOSED fields: `ownerId`,
`ownerProtocolVersion`, `ownerStartedAt`, `idleSinceAt`, `interactiveUntilAt`.

### 6.5 Credentials and tokens for a long-lived owner

Today's credentials fix one bot and one channel at start
(`owner-start-driver.ts:155-168`). A long-lived owner serves other bots and
channels, so it needs credentials that change per turn. Widening the start
credentials to the whole organization would undo finding 4 (tenant-wide reach on
the messaging table), so the design keeps them narrow and mints them later.

**Two tiers (PROPOSED).**

- **Supervisor credentials**, tags `tenant` and `computer` only, from a new role
  `ComputerSupervisorRole`: read and write of the computer's snapshot prefix
  (`tenants/T/computers/K/*`) and nothing else. Its token (new audience
  `computer-owner`, no turn id) opens the host routes: computer, state, snapshot
  hydrated, snapshot published, poll, stop-request, credential refresh.
- **Per-turn credentials**, minted at dispatch with the existing five tags and the
  existing role, 1 hour, handed only to that turn's child process. The gateway
  token and the host token for a turn are minted the same way, bound to the owner
  id so the gateway's "claimed by this owner" check (and its stale-owner defence)
  holds (`conversation/src/http/owner-host-auth.ts:134`; gateway checks per
  [Pi session handoff](PI_SESSION_HANDOFF.md), "The model gateway").

**Who calls STS.** Today only the starter may assume the role
(`infra/lib/computer-host-start.ts:417-430`). The Front Door is internet-facing
and holds more secrets; giving it STS rights widens a large blast radius.
PROPOSED: a tiny `OwnerCredentialBroker` Lambda, invoked synchronously by the
Front Door, is the one principal in both role trust policies (the starter keeps
its own right for the supervisor role). It holds no secrets other than the token
signing key it already needs.

**Renewal.** Compare:

| Option | Behaviour | Verdict |
| --- | --- | --- |
| R1. Cap the owner at one hour | No new route; credentials never outlive the owner | Restarts the computer every hour for an active user, killing dev servers and previews, and cannot finish a turn longer than an hour |
| **R2. Refresh route** | `POST /host/owner/credentials` returns new tokens and credentials, authorised by the current supervisor token, refused when the record's generation, the worker or the heartbeat say the owner is not the live one, and hard-capped by `ownerStartedAt + 8 h` | **Recommended** |
| R3. Give the task role the permissions | Credentials arrive from the task metadata endpoint | Rejected: the shell can reach `169.254.170.2` ([Pi session handoff](PI_SESSION_HANDOFF.md), Limits) |
| R4. OIDC web identity | Control plane is an OIDC issuer; owner calls `AssumeRoleWithWebIdentity` | Rejected for now: needs a public JWKS endpoint and an IAM provider; R2 is enough |

A stolen supervisor token can renew only while the owner is the live generation and
healthy, and never past the 8 hour cap; stopping the computer or bumping the
generation cuts it off, and what was already minted expires within an hour. That is
the same exposure window as today with a kill switch added.

**Inside the container.** The AWS SDK takes a credential provider function, not
static environment values, so the child process reads whichever credentials the
supervisor currently holds over the local socket and never restarts to renew. Pi's
per-call `apiKey` for the gateway is read the same way
(`computer/host/src/owner-models.ts`).

**Bootstrap (D15).** Today the tokens and AWS keys sit in the RunTask overrides,
readable by `ecs:DescribeTasks` for about an hour after the task stops
([Pi session handoff](PI_SESSION_HANDOFF.md), Limits, "Secrets in ECS task
descriptions"). PROPOSED: the override holds one value, a bootstrap token valid for
five minutes and usable once, exchanged on the first poll for the real tokens and
credentials. After that nothing usable remains in the task description.

### 6.6 Snapshot cadence and crash loss

| When | What |
| --- | --- |
| Quiet publish | 30 seconds after the last write when the disk is dirty (turn ended, a file edit landed) |
| Periodic | Every 10 minutes while the disk stays dirty during a busy period |
| Before stop | Always, if dirty |
| On SIGTERM | The existing handler (`owner-main.ts:89-96`) |

A crash loses at most 10 minutes of writes during busy periods and normally less
than a minute, where today a crash loses everything since boot. Background
processes are lost (they restart on request).

**Snapshot v2 (PROPOSED, D7).**

- Each file is written as its own gzip member inside the same tar stream. A tar
  whose entries are separately gzipped members is still a valid `.tar.gz`;
  Node's gunzip reads concatenated members, so `unpackLiveDisk`
  (`pack.ts:137-172`) keeps working unchanged for hydrate.
- A sidecar `index/<checksum>.json` lists every entry: path, kind (file, directory,
  symlink), size, mode, SHA-256, symlink target, and the byte offset and length of
  its gzip member in the pack. It is written before `manifest.json`, and the
  manifest (written last) names the checksum, so a reader always sees a matching
  pair.
- Default exclusions (D7): `node_modules`, `.next`, `dist`, `build`, `target`,
  `.venv`, `__pycache__`, `.cache`, and any single file over 50 MiB (logged as
  skipped). The list is a constant in the image, not a user setting (Section 11).
- Packing streams to S3 as a multipart upload instead of buffering; the checksum is
  computed over the stream.
- Change detection: a scan of size and modified time against the last index, hashing
  only entries that differ, replaces packing the whole disk
  (`disk-lifecycle.ts:71-76`).
- Migration: one run of a re-index script over every existing computer's
  snapshot (the development environment has a handful); then the reader has one
  path (Section 10.1).

**Consistency.** A snapshot taken while processes are writing is
crash-consistent per file (each file's hash is of the bytes the packer read), not
atomic across files. That is the same guarantee as any backup of a live disk.

### 6.7 Crash recovery

Reuse the lost-owner machinery; add nothing for the happy path.

- A per-turn child dies: the supervisor sees it, stops renewing that turn's lease,
  and the turn is recovered by the existing probe (`probes.ts`, attempt lease 60
  seconds, `turns.ts:7`). The recovery enqueues an ordinary run job; a Lambda
  continues the Pi session, the interrupted tool is reported lost, not re-run
  (`actions.ts:302`), and the next computer tool call parks and is polled up again.
- The supervisor or the task dies: heartbeats stop; after 30 seconds the record is
  settled stopped with `hydrateRequired` (`computers.ts:190-208`); the next parked
  turn starts a new owner from the last snapshot.
- An owner that is wedged but alive stops sending the poll that doubles as the
  heartbeat; same outcome.

### 6.8 Image skew, max lifetime, and the watchdog

A long-lived owner outlives deploys, so the contract between Lambdas and owner can
drift.

- **Protocol version.** The poll request carries `protocol_version`. The control
  plane has a minimum; an owner below it receives `drain: true`. A drain stops
  accepting dispatches, finishes the turn in hand (bounded at 10 minutes), publishes
  and reports stopped. Raising the minimum is the operator's way to retire old
  owners without an SHA match (a build-hash match would thrash whenever the image
  pipeline and the Lambda deploy finish at different times).
- **Maximum lifetime.** 8 hours, then drain (D3). This also bounds credential
  exposure and picks up a new image, because the task definition uses a mutable tag
  (`computer-stack.ts:130`).
- **Watchdog.** A bug in the idle timer must not become an idle floor. When the
  starter starts an owner it publishes a delayed `OwnerLifetimeCheck` message,
  re-published every 15 minutes the same way probes re-arm
  (`probes.ts:15`); no cron and no EventBridge rule. The check stops the task
  (`ecs:StopTask`, a new permission) if the owner is older than the cap plus a 30
  minute grace, or if its heartbeat has been silent for 2 minutes while the task is
  still running.

### 6.9 Observability

All lines use the existing emitter, which carries `tenant_id`, `turn_id` and
`owner_id` and never a token, key, tool argument or tool output
(`computer/host/src/owner.ts:218-233`; the rule is stated in the header comment of
`owner-main.ts:39-41`). Existing lines: `owner_started`, `workspace_hydrated`,
`turn_claimed`, `tool_started`, `snapshot_published`, `owner_exit`.

PROPOSED lines:

| Line | Fields |
| --- | --- |
| `owner_idle` | `idle_seconds`, `timeout_seconds`, written when the clock starts and every 5 minutes |
| `owner_polling` | `polls`, `interval_ms`, `dispatches`, per minute only |
| `owner_serving_turn` | `turn_id`, `bot_id`, `queue_wait_ms`, `concurrent` |
| `owner_turn_finished` | `outcome`, `duration_ms` |
| `owner_credentials_refreshed` | `kind` (supervisor or turn), `expires_at` |
| `owner_draining` | `reason` (protocol, lifetime, resize) |
| `owner_stopping` | `reason` (idle, lifetime, drain, sigterm, vetoed), `uptime_ms`, `turns_served` |
| `owner_memory_pressure` | `used_percent`, `stopped_process` |
| `process_started`, `process_exited`, `port_discovered` | `process_id`, `exit_code`, `port` |
| `file_op` | `op`, `bytes`, `path_hash` (a short hash, not the path), `source` |
| `preview_session_opened`, `preview_requests` | counts, bytes, status classes per minute |

The full path of a file operation goes to the audit record (Section 7.5), not the
log.

Useful Logs Insights questions: how long was each owner up versus busy
(`owner_started` to `owner_exit` against `owner_serving_turn` durations), and how
often did a second turn start without a new owner (`owner_serving_turn` where
`queue_wait_ms` is small and no `owner_started` came between).

## 7. File protocol (PROPOSED)

### 7.1 Two sources, one API

| Computer state | Source | Freshness |
| --- | --- | --- |
| Off | The published snapshot, via the v2 index | As of `published_at` (shown in the response and the UI) |
| On | The live disk, through the owner | Current |

The browser sees one REST API and a `source` field. The Front Door decides: if the
computer record says a healthy owner is live, use the owner; otherwise use the
snapshot. If a live request times out, fall back to the snapshot and say so
(`source: "snapshot"`, `stale: true`).

### 7.2 API shape

Under `/orgs/{tenant_id}/computer/files`, user-authenticated like the other
organization routes (`conversation/src/http/user-principal.ts`).

| Request | Meaning |
| --- | --- |
| `GET .../files?path=/workspace/src` | List one directory: name, kind, size, modified time, sha256 when known. At most 2000 entries per call, `truncated` set otherwise |
| `GET .../files/stat?path=` | One entry |
| `GET .../files/content?path=&offset=0&length=262144` | Bytes, UTF-8 text or base64 flagged `binary`, with `sha256` of the whole file, also as `ETag`. At most 256 KiB per call; larger files are read by range |
| `PUT .../files/content?path=` | Create or replace. Body: content and encoding. Header `If-Match: "<sha256>"` to replace, `If-None-Match: *` to create. 200 with the new hash and size; 409 with `current_sha256` on mismatch |
| `GET .../files/recent?limit=50` | Recently touched paths (7.4) |

Path rules: must normalise under `/workspace`, at most 1024 characters, no NUL, no
`..` after normalisation, never the browser-profile tree. Writes under `.git/`
are refused (a hook would run as the shell user at the next `git` call). Content
cap on write: 256 KiB in Phase 3. Everything else is a later phase.

Responses are JSON. File content is never served as a document the browser could
render with the app's origin: the viewer displays text through React, and shows
images only from a fixed list (PNG, JPEG, GIF, WebP) as `Blob` URLs; SVG and HTML
are shown as source. Responses carry `X-Content-Type-Options: nosniff`.

### 7.3 Off: reading from the snapshot (Phase 1)

The Front Door reads `index/<checksum>.json` (cached in the Lambda by checksum; a
10,000 entry index is about 1.5 MB) and answers listings from it. A file read is
one ranged `GET` of the member's gzip bytes, then gunzip, then hash check against
the index. The Front Door role gains read on `tenants/*/computers/*/` in the
snapshot bucket; no new resource (an IAM grant on the existing bucket in CDK).

Symlinks are shown as links with their stored target. The viewer follows a link
only inside the index, at most 8 hops, only to targets under `workspace/`
(`isSafePackSymlink` already guarantees stored targets stay in the tree,
`pack.ts:28-34`).

### 7.4 What Pi is working on (UI)

- **Phase 1, no new API.** The web app already has every tool event, and read,
  write and edit events keep `path` (`tool-event-fields.ts:131-145`). A "Files Pi
  touched" panel groups the current and recent turns' paths, newest first, with
  read/write/edit marks, each opening the file view. It misses changes made by
  shell commands such as `git checkout`.
- **Phase 5.** The owner watches the workspace (recursive `fs.watch`, ASSUMPTION:
  available for Linux in the image's Node 22) and reports changed paths in the poll
  request. `files/recent` then covers shell effects, and the preview uses the same
  signal to reload (7.6).

### 7.5 On: reading and writing through the owner (Phase 3)

A request becomes a short-lived item `T#computer#fileops` (TTL 120 seconds) with an
operation id. The Front Door route writes it, then waits up to 8 seconds,
checking the table every 250 ms, for the result item. The owner picks the request
up in its next poll (the open file panel keeps it in the 0.5 second mode) and runs
it through the **same helper started through the shell launcher** that the file
tools use (`owner-file-helper.ts`). New helper operations: `list` (readdir plus
`lstat`, capped), ranged `read`, and `write` with a precondition. The result goes
back with `POST /host/owner/fileops/{opId}/result` (up to 256 KiB inline; larger
reads are ranged). The owner process itself never opens a path the model or the
person named, which is what closed finding 1.

**Edit conflicts.** The UI sends the hash it last saw. The helper compares the
file's current hash with `If-Match` and writes through a temporary file and an
atomic rename in the same directory, so a reader never sees half a file. A window
of milliseconds remains between the comparison and the rename in which the bot
could write the same file; the response returns the new hash and the UI shows a
conflict banner if the next read differs (ASSUMPTION: acceptable, and rare, since
Pi's own `edit` tool replaces exact text and fails when the text moved). While a
running turn has touched the path in the last minute (from its tool events) the
UI warns "Pi changed this file a moment ago".

**Audit.** The Front Door, not the owner, writes `T#computer#audit` records: user,
path, operation, hash before and after, size, time, source, and whether a masked
file was revealed. The owner's role has no access to that key family, so a
compromised owner cannot erase the trail. Retention is D14.

**Why not "queue the edit as a message to the bot".** It spends model money,
may be reinterpreted, and needs a turn. It stays available as a separate "Ask Pi
to change this" button.

### 7.6 Security of the file protocol

- **Path.** Lexical checks in the Front Door; real-path containment in the helper,
  and the privilege boundary of uid 2000 behind that. Symlinks planted by the shell
  lead only where the shell could already go (`owner-file-helper.ts:1-17`).
- **Who.** Every enabled organization member may read and write, because every
  member can already tell their bot to do the same, and the computer is one shared
  workplace (D8). The existing `resolveUserPrincipal` path enforces membership
  and a paused or disabled organization. Delete and move, when added, need the
  owner role.
- **Secrets in files.** Files whose names look like secrets (`.env*`, `*.pem`,
  `id_*`, `.aws/credentials`, `.git-credentials`, `.npmrc`) are listed but their
  content is masked; a "reveal" call returns it and writes an audit record. This is
  best effort: the bot reads everything, and content can hide in any file.
- **Size and type.** Caps above; binary content returned as base64 only on explicit
  request.
- **Rate.** A per-user limit on file operations per minute so the poll channel
  cannot be flooded.
- **Stale reads.** The snapshot answer says `as_of`; the UI never presents it as
  current.

## 8. Preview (PROPOSED)

### 8.1 Running a dev server so it survives the call

`run_terminal` waits for the command to exit and the turn child ends at the turn's
end. PROPOSED new Pi tools, executed through the supervisor over the local socket:

| Tool | Behaviour |
| --- | --- |
| `start_process` | Starts a command in the background as uid 2000 through the launcher, in a given directory, returns a process id; output goes to a ring log |
| `process_logs` | Last N lines of a process's log |
| `stop_process` | SIGTERM, grace, SIGKILL |
| `list_processes` | Name, command, state, discovered ports |

**Port discovery.** The supervisor reads `/proc/net/tcp` and `/proc/net/tcp6` for
LISTEN sockets and maps socket inodes to process ids through `/proc/<pid>/fd` as
root, for processes of the started tree. No parsing of the dev server's output.
The agent may also state the port. A preview can only target a discovered port in
1024 to 65535.

**Supervision.** No automatic restarts (YAGNI). A process that exits is reported
with its exit code and the tail of its log to the next tool call and the UI. At
shutdown, SIGTERM then SIGKILL (6.4). A process counts as workload for memory
pressure (6.3).

**First target: the Kanbus web console.** `kbs` has a `console` command group
(helpers that drive a running console: `snapshot`, `reload`, `focus` and so on)
and a `daemon`; I could not determine from `kbs --help` which command serves the
web page, on which port, or whether its live updates use WebSocket. Phase 4 starts
with a half-day spike to answer those three questions on a real computer. If it is
a single bundled server, it is the ideal first preview: no hot reload needed.

### 8.2 The path from the browser to the process: options

| Option | Path | Rules | Cost | HMR | Verdict |
| --- | --- | --- | --- | --- | --- |
| **A. Reverse proxy to the task's public IP** | Front Door Lambda connects to `public-ip:port` | Needs inbound on the security group (it is empty by design, `computer-stack.ts:138-142`), a Lambda outside the VPC has no fixed source address so the ingress would be open to the world, plain HTTP over the internet unless the task terminates TLS with a certificate for an IP, the IP changes per task, and "the control plane never reaches into a worker" (req. 12) | Free | No WebSocket through a Function URL; SSE only | Rejected |
| **B. Outbound relay over the poll channel** | Browser, preview distribution, relay Lambda, request item in the table or S3, owner poll, loopback fetch to the dev server, response chunks back | All outbound; no inbound port; no public exposure; no socket | Poll 0.0054 USD/h while a tab is open; bytes about 0.0013 USD per 2 MB (Section 9) | No WebSocket; reload by refresh | **Recommended** |
| **C. Load balancer or VPC origin to the task** | CloudFront (WebSocket capable) to an ALB or NLB to the task IP | Forbidden in front of the API; a preview-only load balancer is D10. CloudFront VPC origins accept ALB, NLB and EC2 instances, not an arbitrary ECS task address (ASSUMPTION; verify) so a load balancer is required | 0.0225 USD/h each, about 16.4 USD/month, 49 USD for three environments, always on | WebSocket works | Rejected unless the owner says otherwise (D10) |
| D. A held streaming tunnel | The owner holds one long request to a Lambda that streams browser requests down | A connection scoped to a tab for up to 15 minutes; also a running Lambda cannot be addressed by another, so it still needs a shared store | Lambda wall-clock about 0.006 USD/h at 128 MB plus the store | Same as B | Rejected: session-lifetime connection |

C compared to the budget: a typical computer costs about 0.76 USD a month
(Section 9). An always-on load balancer is 20 to 60 times that, for a capability
whose only gain is hot reload.

### 8.3 The relay protocol (option B)

1. The app calls `POST /orgs/:tenant/computer/previews` with a process id or a port.
   The Front Door checks membership, that the computer is live, and that the port
   is in the discovered set. It writes a session item `T#preview#<sid>` (tenant,
   computer, port, user, expiry) and returns
   `https://<sid>.<preview-domain>/`. `<sid>` is 128 random bits.
2. The iframe loads that address. The request reaches a **separate CloudFront
   distribution** with a wildcard alternate domain name and a wildcard certificate
   (certificates must live in us-east-1 for CloudFront; ASSUMPTION), caching
   disabled. A viewer-request CloudFront Function copies the Host header to
   `x-chatticus-preview-host`.
3. The **PreviewRelay Lambda** (new, minimal IAM: read and write its own key family,
   read the S3 transfer prefix; no model key, no signing key) looks up the session.
   Unknown, expired or revoked: 404 with no detail.
4. It writes `req#<ulid>`: method, path and query, an allow-list of headers
   (cookies included, since they belong to this preview origin only), and the body
   up to 1 MiB. TTL 60 seconds.
5. The owner receives pending requests in its poll (up to 20, handled with
   concurrency 8). It issues a loopback HTTP request to `127.0.0.1:<port>` with the
   Host header set to `localhost:<port>` (several dev servers refuse unknown
   hosts), `redirect: manual`, never any other address. It rewrites `Location`
   headers that point at `localhost:<port>` to the preview address, compresses
   textual bodies with gzip if the dev server did not, and posts the response.
6. Response parts up to 32 KB travel as table items; larger parts are put under
   `tenants/T/computers/K/transfer/` in the snapshot bucket (the supervisor
   credentials already allow it) with a one-day lifecycle rule, and an item points
   to them. Table writes are 1 write unit per KB, so a 256 KB item costs about
   0.00016 USD; an S3 put costs about 0.000005 USD whatever its size, hence the
   split.
7. The relay streams the parts to the browser as they appear, polling the table
   every 100 to 200 ms. First byte timeout 25 seconds, then 504.
8. Limits per session: 20 requests per second, 25 MB per response, 500 MB per
   hour, 3 live sessions per computer.

**Latency, honestly.** Each request costs the owner's poll wait (at 0.5 s mode,
average 0.25 s), the dev server, one result post and the relay's table poll: about
0.4 to 1 s each, in parallel up to 8. A bundled application of 30 requests loads
in 2 to 5 seconds. An unbundled Vite page with 300 modules would take 15 to 40
seconds the first time. That is a limit of "no sockets, no inbound", and Phase 4
measures it before promising more.

### 8.4 Hot reload without a WebSocket

Options:

1. **Refresh on change (recommended).** The app polls
   `GET .../previews/:id/version` every 2 seconds while the tab is visible (about
   0.0014 USD/h). The owner's file watcher bumps the version when files change
   (debounced 1 second after the last change). The app reloads the iframe by
   assigning its `src` again. Works with every dev server. Loses in-page state.
2. Framework-supplied non-WebSocket transport. ASSUMPTION, each to be verified in
   the Phase 4 compatibility test: older Next.js used `EventSource`; webpack dev
   server has a SockJS transport with HTTP fallbacks; Vite's client is
   WebSocket-only as far as I know. A dev server whose WebSocket cannot connect
   may log errors or reload in a loop, so the start recipe for each (a short
   "how to start this framework for preview" instruction the agent follows) must
   switch its live reload off. The Phase 4 matrix lists Vite, Next.js, webpack and
   the Kanbus console.
3. WebSocket through a load balancer. Needs D10 and D11 answered yes.

### 8.5 Security boundaries (see the preview diagram)

- **Separate origin (D12).** The app keeps its sign-in tokens in `localStorage`
  (`web/lib/auth.ts:236`); a script on the same origin could read them. The
  preview must be a different origin. A subdomain of `chattic.us` would still let a
  preview page set cookies for the whole `chattic.us` site (cookie tossing), so I
  recommend a separate registrable domain used for nothing else, one wildcard
  certificate, one random hostname per session. That also separates previews from
  each other.
- **Capability address.** There is no cookie. Third-party cookies in an iframe are
  unreliable (blocked by some browsers), so the unguessable hostname is the
  credential. It is protected by: 128 bits of randomness; a wildcard certificate so
  hostnames do not appear in certificate transparency logs; sliding 15 minute
  expiry, 8 hour maximum; revocation when the person closes the tab or the
  computer stops; `Referrer-Policy: no-referrer`; and sessions bound to one
  organization, one computer and one port. Anyone who copies the address while the
  session is live can open it, like a screen share. Accepted; tighten later with a
  ticket exchange if needed.
- **Embedding.** The relay replaces any `X-Frame-Options` and removes the
  `frame-ancestors` directive from a dev server's own `Content-Security-Policy`,
  then adds `Content-Security-Policy: frame-ancestors <app origin>` so only the app
  can frame it. The iframe is created with `sandbox="allow-scripts allow-same-origin
  allow-forms allow-popups allow-modals"` (no `allow-top-navigation`) and an empty
  `allow` attribute (no camera, microphone, location). The relay adds
  `X-Content-Type-Options: nosniff`.
- **Cross-origin isolation (to verify).** On development the app sends
  `COOP: same-origin` and `COEP: require-corp` (`web-stack.ts:104-113`). A page
  embedded under `require-corp` generally must itself be cross-origin isolated or
  carry `Cross-Origin-Resource-Policy`; I have not tested this in a browser
  (ASSUMPTION). If it holds, the relay adds `COEP: credentialless` and
  `CORP: cross-origin`, or the isolation headers are narrowed to the voice route.
  Phase 4 must test this on development first, where it applies.
- **SSRF.** The relay reaches nothing by name. The destination is a table lookup
  (session, computer, port) executed **by the owner of that computer** against
  `127.0.0.1`. The relay never opens a network connection to an address derived
  from a request. The owner never follows a redirect off loopback and never uses
  a hostname.
- **Abuse.** Rate and byte limits (8.3 step 8) and per-computer session cap.
- **Origin protection.** The preview Function URL is created with IAM
  authentication and CloudFront origin access control from the start, not the
  shared secret header the Front Door still uses
  ([AWS authentication](AWS_AUTH.md), "Proposed, not built"). Its obstacles
  (SigV4 overwriting `Authorization`, signed bodies on POST) do not apply to a
  relay that takes no bearer, but POST bodies must be tested (ASSUMPTION: OAC with
  Lambda URLs requires the payload hash header on POST and PUT). If that blocks
  forms in previews, fall back to a secret header and a capability-checking
  relay, which is acceptable here because a request without a live session id gets
  404 anyway.
- **What a preview page can do.** Anything a website can do. Prompt-injected pages
  can phish. The frame carries a fixed banner outside the iframe: "Preview from
  your computer. Treat it like any website."

## 9. Cost model

Prices (US East, ARM64 Fargate; ASSUMPTION, taken from memory and not re-verified
in this session since no AWS call was made): vCPU 0.03238 USD/h, memory 0.00356
USD/GB-h, public IPv4 address 0.005 USD/h.

| Task size | Compute only | With public IPv4 | 24 h | 24 h with IP | Per month, always on |
| --- | --- | --- | --- | --- | --- |
| 0.25 vCPU, 0.5 GiB (today) | 0.0099 | 0.0149 | 0.24 | 0.36 | 7.21 / 10.86 |
| 0.5 vCPU, 1 GiB | 0.0198 | 0.0248 | 0.47 | 0.59 | 14.42 / 18.07 |
| 1 vCPU, 2 GiB | 0.0395 | 0.0445 | 0.95 | 1.07 | 28.84 / 32.48 |

The public address matters: the VPC has no NAT gateway
(`computer-stack.ts:51`) and tasks start with one (`host-starter.ts:181`), so the
real cost of the current size is about 1.5 cents an hour, not 1.

**Usage model.** A work burst is four computer turns over 10 minutes of wall time
with a 0.5 minute start. Today each turn starts its own task and bills about 2
minutes (0.5 start, 1.5 run, Fargate minimum 1 minute): 8 minutes a burst. A
long-lived computer bills the start, the 10 minutes, and then the idle timeout T.
Bursts are assumed to be further apart than T, so each starts a computer. Dollars
per organization per day at 0.25 vCPU / 0.5 GiB, compute only (with IP in brackets).

| Pattern | Today (one turn) | T = 5 min | T = 15 min | T = 30 min | T = 60 min |
| --- | --- | --- | --- | --- | --- |
| Light: 2 bursts | 0.003 (0.004) | 0.005 (0.008) | 0.008 (0.013) | 0.013 (0.020) | 0.023 (0.035) |
| Typical: 6 bursts | 0.008 (0.012) | 0.015 (0.023) | 0.025 (0.038) | 0.040 (0.060) | 0.070 (0.105) |
| Heavy: 12 bursts | 0.016 (0.024) | 0.031 (0.046) | 0.050 (0.076) | 0.080 (0.121) | 0.139 (0.210) |
| One 4 hour session with a dev server | n/a | 0.040 (0.061) | 0.042 (0.063) | 0.045 (0.067) | 0.050 (0.075) |
| Never switches off (ceiling) | | | 0.24 (0.36) | | |

Read this honestly: a long-lived computer costs about three times today's bill for
the same bursts, because today the machine is off while the person thinks. The
absolute number is small: typical use at T = 15 is about 0.76 USD a month (1.14
with the address), against 0.24 today. What the person gets for it is follow-ups in
seconds instead of about 30, and files and previews that can exist at all.

**Other costs.**

| Item | Cost |
| --- | --- |
| Poll, idle (10 s) | 0.00027 USD/h, 3 percent of the task |
| Poll, busy (1 s) | 0.0027 USD/h |
| Poll, preview or file panel open (0.5 s) | 0.0054 USD/h |
| Preview bytes | about 0.0013 USD per 2 MB through the table; about 0.00001 per object through S3 above 32 KB |
| Watchdog | 32 messages in 8 hours, negligible |
| Preview load balancer, if D10 were yes | 16.4 USD per month per environment |

## 10. Migration, with no compatibility forks

### 10.1 What is replaced and deleted when the new path lands

| Today | Fate |
| --- | --- |
| Single-job source and `owner_no_job` (`owner.ts:51-63`, `owner-main.ts:59-65`) | Deleted; the supervisor loop replaces them |
| `runOwnerOnComputerDisk` publish-and-stop after one turn (`owner.ts:279-332`) | Replaced by supervisor lifecycle: hydrate once, publish by cadence, stop by idle |
| `CHATTICUS_TAKEOVER_TURN_ID`, `CHATTICUS_TAKEOVER_BOT_ID` in the start environment (`owner-start-driver.ts:190-192`) | Deleted; dispatch arrives by poll |
| Start requires a turn and takes the channel from it (`owner-start-driver.ts:134-138,157-163`) | Start needs only tenant and computer; per-turn tags are applied at dispatch |
| Scoped AWS keys and both tokens in RunTask overrides (`owner-start-driver.ts:188-209`) | Replaced by one bootstrap token (D15) |
| The `owner-host` token tied to one turn on the five routes (`owner-host-auth.ts:119-140`) | Replaced by the `computer-owner` audience; per-turn tokens remain for the gateway |
| `hostDiskNeedsPublish` packing the disk to compare (`disk-lifecycle.ts:71-76`) | Replaced by the index scan |
| Unindexed snapshots | One re-index run per computer, then the reader has a single code path |
| The legacy own-account Fargate host service and task definition (`computer-stack.ts:81-155`), already marked for removal in [Pi session handoff](PI_SESSION_HANDOFF.md) | Remove in Phase 2's infra change |

### 10.2 Order and the cut-over

Only development runs the owner path ([Pi session handoff](PI_SESSION_HANDOFF.md),
Limits), so there is no staging or production data to migrate. Per phase: deploy
the control plane first (new routes are additive), then the image, then start new
owners. An owner that is mid-turn at deploy time ends its turn with the old
contract; at most one is in flight on a single-household environment. Customer-account
computers keep the host worker and the host protocol unchanged
([TypeScript control plane](TYPESCRIPT_CONTROL_PLANE.md), section 4.2): none of
this applies to them, and the file API for them reads the snapshot only until a
decision is made (Section 11).

## 11. Phases

Each phase ships alone and is testable alone. Order is set by dependencies: the
index (1) is needed by the off-state file view and by the live view's fall-back;
the supervisor and poll channel (2) carry everything after it; live files (3) use
the channel; processes and preview (4) need the channel, benefit from file-change
events, and need the larger task.

### Phase 1: snapshot index and read-only file view

- **Scope.** Snapshot v2 (per-file members, index, exclusions, streaming pack);
  Front Door read on the snapshot bucket; list, stat and content routes with
  `source: "snapshot"`; web file panel and "Files Pi touched" from tool events;
  re-index script.
- **Gherkin.** `features/computer_snapshot_index.feature` (publish writes a
  matching index; a member lists and reads a file; excluded directories absent;
  traversal, symlink escape, non-member and secret-masking refusals; `as_of`
  reported) and the existing `computer_snapshot_pack.feature` /
  `computer_snapshot_restore_safety.feature` stay green.
- **Live proof.** Ask a bot on development to create two files and a folder; after
  the turn, browse and open them in the web app; confirm a `node_modules`
  directory is absent from the index and the owner's memory stayed under 300 MiB
  publishing a 400 MB workspace.
- **Depends on.** Nothing. Works with today's one-turn owner.

### Phase 2: long-lived owner (two shippable steps)

- **2a, supervisor and poll.** Supervisor loop, poll route (heartbeat merged),
  dispatch of parked turns, per-turn child, per-turn credentials through the
  broker, idle timeout and stop-request with veto, quiet publish, the
  `already_serving` start check, max lifetime 50 minutes (no renewal yet), the
  watchdog, new log lines, removal of the legacy host service.
- **2b, renewal.** Refresh route, credential providers in the child, bootstrap
  exchange, protocol-version drain, lifetime raised to 8 hours.
- **Gherkin.** `features/computer_owner_long_lived.feature`: a second turn is served
  by the live owner without a start; a turn parked behind a busy owner waits and
  then runs; idle timeout publishes and stops; stop is vetoed by pending work; a
  stale start job is acknowledged as already serving; a crash mid-turn is recovered;
  per-turn credentials cannot touch another channel; refresh extends credentials
  and is refused for a stale generation or a stopped computer; old protocol drains.
  Extend `owner_role_policy.feature` for the supervisor role.
- **Live proof.** Two messages five minutes apart: the second one's first computer
  action starts within 5 seconds with no `owner_started` between them; idle
  shutdown logs `owner_stopping reason=idle` and a published snapshot; stop the
  task mid-turn and watch recovery; leave a computer up across a credential
  refresh.
- **Depends on.** Phase 1 only for the snapshot streaming and exclusions.

### Phase 3: live file view and edit

- **Scope.** File-request items and result route, helper `list`, ranged `read` and
  conditional `write`, `PUT` content, audit records, conflict UI, fast poll mode
  while the panel is open.
- **Gherkin.** `features/computer_file_live.feature`: a live read reflects an
  unpublished change; a write with a stale hash is refused; an edit lands in the
  audit log; a planted symlink is contained; a timeout falls back to the snapshot
  with `stale`; the owner cannot read the audit family.
- **Live proof.** Edit a file in the web app while a turn is idle; ask the bot to
  read it back; edit it from both sides at once and see the conflict.
- **Depends on.** Phase 2a.

### Phase 4: background processes and preview

- **Scope.** Spike on the Kanbus console first. Process tools and table, port
  discovery, memory guard, default task size 0.5 vCPU / 1 GiB, preview sessions,
  PreviewRelay Lambda and distribution, wildcard certificate and domain (CDK),
  iframe with banner, refresh on change (needs the watcher from Phase 5 or a
  poll-based change check at first), compatibility test matrix.
- **Gherkin.** `features/computer_background_process.feature` (a process outlives
  the turn; ports discovered; logs readable; stopped at shutdown),
  `features/computer_preview_relay.feature` (a request is relayed; only the session's
  computer and port are reachable; redirects stay on the preview address; expired,
  revoked and cross-organization sessions get 404; framing headers rewritten; size
  and rate limits).
- **Live proof.** The agent starts the Kanbus console; the person opens the tab and
  clicks through it; the isolation-header interaction on development is observed in
  a real browser.
- **Depends on.** Phase 2a; Phase 3 for change events (or a stat-based fallback in
  the first cut).

### Phase 5: polish

Watcher-based change events and `files/recent`; two concurrent turns after
measurement; "shuts down in N minutes" in the UI; admission sends a turn straight
to a warm owner; delete and move with the owner role; automatic resize hint on
out-of-memory.

### What to cut (YAGNI)

- Automatic resize and restart on out-of-memory (a message to the operator first).
- A user-editable snapshot include or exclude file.
- Automatic restart of crashed dev servers.
- Channel notices when a person edits a file.
- Delete, move, upload and download of large files.
- Multi-viewer previews with per-user access; a session has one creator.
- Per-organization idle timeouts.
- Direct dispatch to a warm owner (Phase 5 optimization only).
- A WebSocket, a load balancer, a streaming tunnel.
- Customer-account computers (they keep the host worker; Section 10.2). Their file
  view could read their snapshot bucket via assume-role, but that needs its own
  decision.

## 12. Risks and unverified assumptions

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | **Memory at 512 MiB.** Supervisor plus Pi plus a dev server does not fit; pack builds the archive in memory | Streaming pack, exclusions, 0.5 vCPU / 1 GiB by Phase 4, a memory guard, measured in Phase 1 |
| 2 | **Preview page-load time** through a poll-based relay | Measure first; document the limit; bundled targets first; gzip at the owner |
| 3 | **Two live disks** if a late start job races a live owner | `already_serving` check; scenario; generation compare stays |
| 4 | **An idle-timer bug becomes an idle floor** | 8 hour cap, drain, independent watchdog message chain, log alarm on uptime beyond the cap |
| 5 | **Isolation headers break the embedded preview** on development | Test early in Phase 4; narrow the headers or add `credentialless` |
| 6 | **Credential broker** is a new privileged component | One function, no other secrets, fixed role ARNs, tag allow-list from `ownerSessionTags` |
| 7 | **Dev-server compatibility** (host checks, absolute URLs, failing WebSocket clients) | Host rewrite, `Location` rewrite, per-framework start recipes, a test matrix |
| 8 | **Snapshot v2 migration** touches every existing computer | One re-index run on development; the reader refuses an unindexed snapshot after |
| 9 | **User edit and bot write race** | Hash precondition, atomic rename, UI warning from tool events |
| 10 | **Review findings not yet fixed** (gateway has no per-call ceiling; invoke key in the distribution configuration) | Out of scope here; unchanged by this design; spend exposure grows with uptime but remains bounded by the monthly ceiling |

**Riskiest assumption.** That a poll-based relay gives a page-load time a person
will accept for the first target. If it does not, the choices are a smaller
promise (static or bundled apps only) or a rule change (D10, D11); the design
leaves both available.

**Could not verify in this session.** Price figures (no AWS calls were made); what
TS-61 refers to (Kanbus is not to be read directly); the Kanbus web console's
command, port and transport; how browsers treat a cross-origin iframe under the
development site's `COEP: require-corp`; whether CloudFront OAC accepts POST to a
Lambda URL without client-signed payload hashes; whether CloudFront accepts a
wildcard alternate name for a distribution in this account; Function URL streaming
response size limits; behaviour of Vite, Next.js and webpack clients when their
WebSocket cannot connect; `oom_score_adj` writes from the launcher on Fargate;
recursive `fs.watch` on Linux in the image's Node; the default Fargate ephemeral
disk (20 GiB, not set in CDK); and real memory use of two Pi sessions. Each has a
named test in the phase that depends on it.

## 13. Rejected alternatives

- **Push to the owner** (a Lambda calls the task): inbound port, unstable address,
  rule 12.
- **A queue per computer**: run-time resource creation, not CDK; cannot be
  consumed selectively on a shared queue.
- **Long-poll inside the Function URL**: bills a 512 MB Lambda for the wait, 2.4
  times the computer itself.
- **Application Load Balancer or NLB for previews**: idle floor, D10.
- **API Gateway WebSocket or AppSync for previews**: metered per message and
  connection, the bill the project already paid once
  ([Design challenges](DESIGN_CHALLENGES.md), "Why no sockets is a cost rule").
- **Held streaming tunnel**: a connection scoped to a tab.
- **Mounting S3 or EFS as `/workspace` so files are always visible**: against
  [Computer snapshots](COMPUTER_SNAPSHOTS.md) ("Why not just leave it in S3");
  would also make a second live writer possible.
- **Per-file S3 objects as the snapshot** (content-addressed blobs): better
  incremental publish, but changes hydrate (thousands of small GETs), changes the
  documented layout and tests; the per-member gzip index gets the same read path
  with the archive unchanged.
- **Prefix-path previews** (`/preview/<id>/...`): break root-relative URLs that dev
  servers emit unless each is configured with a base path.
- **Cookie-based preview sessions**: unreliable in third-party iframes.
- **Give the task role the owner's permissions**: the shell reaches the task
  credentials endpoint.
- **A one-hour owner lifetime**: restarts active users hourly.
- **Queue an edit as a chat message to the bot**: slow, costs model money,
  nondeterministic.

## 14. Security: what changes in the threat model

**New or enlarged exposure.**

| Threat | Why it is new | Mitigation |
| --- | --- | --- |
| Longer credential window | Owner lives up to 8 h instead of one turn | Two tiers, per-turn keys expire in 1 h, renewal refused for a stale generation or stopped computer, kill switch, hard cap, bootstrap token replaces secrets in the task description |
| A persistent foothold in the sandbox | A prompt-injected turn can leave a background process running past the turn | Same user (uid 2000), same filesystem reach as the snapshot already persists; processes die at shutdown; egress control remains the open item it already is |
| Larger privileged component | The supervisor persists, holds computer-level keys and a local socket | Supervisor credentials limited to the snapshot prefix; socket mode 0600 root; child per turn holds the session keys |
| Preview as a phishing and exfiltration surface | Bot-authored pages are shown inside the app | Separate registrable domain, sandboxed frame, fixed banner, no cookies, capability address with expiry |
| Same-origin script reading tokens | `localStorage` tokens (`auth.ts:236`) | Never the same origin; frame sandbox without top navigation |
| SSRF | A proxy exists | No network connection derived from a request; owner fetches loopback only; session-fixed port |
| Open relay abuse | Bandwidth and cost | Per-session rate, byte and session caps; sessions bound to a member and an organization |
| File API as a data path | New way to read a whole workspace | Member-only, audit, masking, size and rate limits; the same reach a member already has through a bot |
| Audit tampering | Edits by people need a trail | Written by the Front Door; the owner role cannot touch the family |
| Cross-organization mixing | One owner serves all bots and members of one organization | Unchanged by design (one disk per organization, bots not a boundary); per-turn keys keep each bot's conversation store separate; no owner serves two organizations |

**Earlier review findings, status under this design.**

| Finding | Status |
| --- | --- |
| 1. Symlink escape in file tools | Holds: fixed by the unprivileged helper (`owner-file-helper.ts:1-17`); the new file operations reuse it and add no path the owner opens itself. A scenario with a planted link covers each new operation. |
| 2. Invoke key reaches every owner | Holds: the owner holds a signed token, not the invoke key (`owner-host-auth.ts:6-14`). The new supervisor audience adds no shared secret. |
| 3. Secrets in RunTask overrides | Improved by D15: only a five-minute single-use bootstrap token remains there. If D15 is declined it is unchanged and, with refresh, the first credentials are still one hour. |
| 4. Tenant-wide table reach | Holds: the supervisor role is narrower than the per-turn role; the per-turn role is the current policy file. |
| 5. Gateway has no per-call ceiling | Unchanged; a longer-lived owner makes a runaway loop last longer until the monthly ceiling. |
| 6. Invoke key in the CloudFront configuration | Unchanged for the API; the preview distribution does not use a shared header (8.5). |
| 7. Snapshot restore | Holds: `assertPackMembersAreSafe` and `isSafePackSymlink` stay (`pack.ts:177-247`); the multi-member format is read by the same extractor. |
| 8. Worker tokens never expire | Unchanged for customer hosts; the owner worker is registered per start by the starter. |

## 15. Regenerating the diagrams

The sources are the three `.json` files in `docs/diagrams/long-lived-computer/`.
The `.html` files are generated from them with the Archify skill. From the
repository root, with Archify installed at `ARCHIFY`:

```bash
node "$ARCHIFY/bin/archify.mjs" finalize architecture \
  docs/diagrams/long-lived-computer/proposed-architecture.architecture.json \
  docs/diagrams/long-lived-computer/proposed-architecture.html \
  --quality showcase --json

node "$ARCHIFY/bin/archify.mjs" finalize sequence \
  docs/diagrams/long-lived-computer/turn-to-live-owner.sequence.json \
  docs/diagrams/long-lived-computer/turn-to-live-owner.html \
  --quality showcase --json

node "$ARCHIFY/bin/archify.mjs" finalize sequence \
  docs/diagrams/long-lived-computer/preview-request.sequence.json \
  docs/diagrams/long-lived-computer/preview-request.html \
  --quality showcase --json
```

Delete the `*.finalize*.json`, `*.browser-check.json` and `*.delivery.json`
receipts the command writes next to the output.

## See also

- [Pi session handoff](PI_SESSION_HANDOFF.md): how a turn reaches the computer today.
- [Computer snapshots](COMPUTER_SNAPSHOTS.md): publish, hydrate, relocate.
- [Design challenges](DESIGN_CHALLENGES.md): requirements, non-requirements, and why
  there are no sockets.
- [Messages and the cloud API](MESSAGING.md): the front door and the stream.
- [TypeScript control plane](TYPESCRIPT_CONTROL_PLANE.md), section 4: the computer.
- [AWS authentication](AWS_AUTH.md): origin protection and key rules.
