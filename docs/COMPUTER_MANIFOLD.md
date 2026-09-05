# Computer manifold

**Living memo — verified through September 3, 2026**

## Purpose

This memo records the developing argument for how Chatticus should place,
start, idle-stop, and snapshot **computer** work across heterogeneous hosts.
It is intended to survive the originating conversation and serve as the
starting point for later product strategy, architecture, and implementation.

The central claim is narrower—and stronger—than "pick Fargate or EC2 per
turn":

> **Agents declare a kind of work, not a host. A computer manifold
> provisions the right host shape, idle-stops it when work ends, and keeps
> one live disk per `computer_id`. S3 is the one durable workplace store.**

In shorter form:

> **The workplace is an identity. Hosts are interchangeable executors.
> Snapshots are the contract between them.**

This memo does **not** implement the manifold, EFS, an Antharchy AMI, or a
tunneled local-host path. It names what is live today, what is proposed,
and what is explicitly out of scope.

> **Superseded in part, September 3, 2026.** A storage design conversation
> (initiative `chatticus-fbae4e`) moved the workplace store from S3
> snapshots to **one EFS filesystem mounted by every host class**, reached
> over an outbound tunnel by hosts outside the VPC. Sections 4, 6, and 7
> carry the specific supersede notes. What is described as *live today*
> (section 1) remains accurate; the snapshot protocol is still the running
> system and stays until EFS lands.

---

## 1. What exists today (verified on `develop`)

### 1.1 Workplace identity, not machine

A Chatticus **computer** is a workplace identity (`computer_id`), not a
particular Mac, Fargate task, or EC2 instance. The durable workplace is a
**snapshot in S3**. Any machine that can run the computer image is a
**host**. See [Computer snapshots](COMPUTER_SNAPSHOTS.md).

The computer is **organization-scoped**: every bot in an organization shares
one workplace, one browser profile tree, and one `/workspace`. See
[Product](PRODUCT.md) and `computer_for_organization` in the control plane.

### 1.2 v1 AWS host: Fargate ARM64, scale to 0

The CDK `ChatticusComputers` stack defines the v1 AWS computer host:

| Setting | Value |
| --- | --- |
| Platform | ECS Fargate |
| Architecture | ARM64 |
| CPU / memory | 0.25 vCPU (256 units) / 512 MiB |
| Default desired count | 0 (scale to 0) |
| Live root | `CHATTICUS_LIVE_ROOT=/var/lib/chatticus/computer` (ephemeral task disk) |
| Network | Egress only; no inbound ports |

Cold summoned `RunTask` browser-gate timings for this task size are on the
order of **26 s** median (Test 2 spike, August 2026). That is startup
latency, not a product SLA.

### 1.3 Computer image

The workplace image is **Debian bookworm** (`python:3.12-slim-bookworm`) with
**Xvfb** and **Chromium** from apt. The same image is intended to run on
Fargate, EC2, and local Docker. It is **not** a full desktop distribution.

Capability gates are independent: the agent may answer from memory or MCP
tools while `/workspace` hydration and the browser stack still come up. See
[Architecture](ARCHITECTURE.md).

### 1.4 Snapshot contract

Canonical durable objects per `computer_id`:

```text
s3://…/tenants/{tenant_id}/computers/{computer_id}/
  snapshot.tar.gz    # workspace + browser profiles only
  manifest.json      # image digest, checksum, published_by, published_at
```

The registry image (ECR) holds OS layers. The snapshot holds **only** the
durable workplace files. Bot memory, chats, skills, and secrets are not in
the pack.

**Relocate** is not a container copy. It is **publish**, then **hydrate** on
the next host. While `hydrate_required` is set, turns for that
`computer_id` go only to the intended host. **Two hosts running the same
`computer_id` with two live disks are forbidden** — no split brain.

### 1.5 Summoned Fargate worker lifetime

The Fargate host override (`python -m chatticus.computer_host_worker`) polls
for at most **`CHATTICUS_HOST_WORKER_SECONDS` (default 120)** before
exiting. That is today's practical ceiling on a headless Fargate session
without changing the worker loop or service model.

### 1.6 EFS: mentioned, not implemented

Docs and architecture tables mention **EFS as a possible AWS-side cache** of
the same files S3 already canonicalizes. **EFS is not implemented.** S3
remains the one durable workplace store. EFS would not attach to a home Mac;
a Mac still hydrates from S3.

---

## 2. The manifold (proposed control-plane role)

Today, callers and operators reason about **hosts** (garage Mac, summoned
Fargate task, future EC2). The manifold is the layer that should sit between
**work intent** and **host choice**:

```text
Agent / routine / human
        |
        v
  declare work kind  (not "run on Fargate")
        |
        v
  Computer manifold
    - pick host shape
    - start or attach
    - enforce one live disk
    - idle-stop and publish
        |
        v
  Host runs computer image + pull worker
        |
        v
  S3 snapshot (canonical)
```

The manifold does not replace the snapshot protocol. It **uses** publish,
hydrate, dirty-disk, and relocate rules already specified in
[Computer snapshots](COMPUTER_SNAPSHOTS.md).

---

## 3. Work kinds (proposed, not implemented)

Agents should declare **what shape of computer session** they need. The
manifold maps that declaration to a host class. These kinds are design
targets for a future API; none of them is a second live-sync path.

| Kind | Intent | Likely host | Notes |
| --- | --- | --- | --- |
| **Batch** | CLI / async work; no long-lived session | Fargate task or local runner | Fits today's summoned `RunTask` + publish pattern |
| **Headless session** | Long-lived shell/browser without a human desktop | Fargate **if** we stop exiting at ~120 s | Default `CHATTICUS_HOST_WORKER_SECONDS=120` blocks this today |
| **GUI session** | Hyprland desktop, human watch/takeover | **Antharchy on EC2** or local VM | Not the slim Debian Fargate image |
| **Edit-on-Mac / compute-on-cloud** (optional, name TBD) | Mutagen-*style* dev sync | Mac editor + remote compute | **Do not dual-live-sync** two writable disks for one `computer_id` |
| **Accelerated batch** (added 2026-09-03) | ML training, fine-tuning, long GPU runs | GPU EC2 (g5, p4d, p5) **or owned hardware** | Object I/O only -- pull dataset, train, push weights. No filesystem mount, no display. See below. |

**Accelerated batch is the work kind where non-AWS compute pays.** A g5.xlarge
is ~$1/hr and a p4d.24xlarge ~$32/hr, against electricity on hardware an
organization already owns; a multi-day training run is a four-figure
difference, not the ~$0.01/hr the slim Fargate computer costs.

It is also the *easiest* host class to support, because it needs the least:
no display, and no filesystem mount. Datasets and checkpoints are large
objects, and **data transfer into AWS is free while egress is ~$0.09/GB**, so
the shape that costs least is also the natural one -- keep the dataset local,
train locally, `PUT` the weights to S3. Egress is charged only if a local
host pulls a large dataset *out* of AWS, which argues for keeping training
corpora on the side of the boundary where they are consumed.

An accelerated-batch host therefore needs only SQS and scoped S3
credentials. It is the highest-value non-AWS host class and the one with the
thinnest requirements.

### 3.1 Omarchy and Antharchy

**Omarchy cannot be the Fargate computer image.** Omarchy is a full Arch
desktop stack (Hyprland and friends). The Fargate image is intentionally
minimal: Debian, Xvfb, Chromium, worker, agent.

Ryan confirmed **Omarchy belongs on EC2** for GUI sessions. The public
AnthusAI **Antharchy** repository is the copy to rebrand for that path. That
is a **separate AMI / host class**, not a swap of the current
`computer/Dockerfile`.

### 3.2 Local hosts (outside the VPC)

A **local host** on hardware that is already on -- garage Mac, home server,
an owned GPU box -- is cheap when idle cost is effectively zero. The same
**pull worker protocol** applies: outbound-only registration, no inbound
ports. A local worker is always a **Linux VM**, never macOS directly.

Two shapes, with very different requirements:

- **Accelerated batch** needs only SQS and scoped S3 credentials. No tunnel,
  no mount, no display. This is the host class that saves real money.
- **GUI session / interactive work** needs `/org` and `/workspace`, which
  means an outbound tunnel to reach the EFS mount target, plus a reverse
  channel for watch/takeover. Both ride one tunnel.

Connectivity is stated as a **requirement, not a product**: an outbound-only,
mutually authenticated channel the worker opens; no host accepts inbound
connections. WireGuard is the default implementation because it is the
smallest thing that satisfies it; reverse SSH, SSM Session Manager, and mesh
VPNs also qualify. **Nothing in the Chatticus codebase imports any of them.**

**Do not implement** in this memo's scope. See `chatticus-fbae4e` for the
design and `chatticus-3c6df9` for the display path.

---

## 4. EFS as the store (chosen 2026-09-03; supersedes this section's earlier position)

This section previously held that EFS was a **cache or shared read-mostly
tree, not a second durable workplace store**, and that a home Mac would keep
hydrating from S3. That position rested on a premise that turned out to be
false: that the local client is macOS. **A local worker is always a Linux VM**
with a working kernel NFSv4.1 client, and a VPC-private mount target is
reachable over an outbound WireGuard tunnel on a stopped-when-idle endpoint
(~$0.65/mo).

The chosen design is **one EFS filesystem**, with `/org` and `/workspace` as
directories distinguished by access points and permissions -- not two
storage systems. Every host class mounts the same filesystem at the same
paths and runs the same code.

Why this beats the snapshot model: the disk-write lease, `hydrate_required`,
publish/hydrate, and relocate-as-publish-then-hydrate all exist for one
reason -- **S3 has no locking**, so two hosts can both hydrate, both write,
and both publish, with the second publish silently destroying the first. EFS
has POSIX locking. The two-writer problem is not solved; it stops existing.

Costs and boundaries that survive:

- **Storage still bills** while data is on EFS -- and at roughly an order of
  magnitude more per GB than S3, which is why large objects stay objects.
- **Datasets, model weights, screenshots, and artifacts remain in S3.** That
  is files versus objects, not a second file store.
- **Regenerable output** -- build directories, dependency trees, caches --
  is host-local scratch. It never crosses the tunnel and is never canonical.
- **WAN metadata latency is the real cost** and is handled with stock Linux
  (FS-Cache via `cachefilesd`, `nconnect`, generous `actimeo`), not with
  architecture. This assumption is **unmeasured** and should be measured
  before implementation.

Full rationale, rejected alternatives, and security model: `chatticus-fbae4e`.

---

## 5. Cost shape (order-of-magnitude)

These figures are planning anchors from the September 3, 2026 design
conversation and public Fargate pricing; recheck before budgeting.

| Shape | Idle cost | Running cost (indicative) |
| --- | --- | --- |
| Fargate ARM64 0.25 vCPU / 512 MiB, desired count 0 | **$0** | **~$0.01/h** while the task runs |
| Same Fargate size, always on | Non-zero 24/7 | **Not cheaper** than a rightsized always-on EC2 for continuous load |
| EC2 stop/start with EBS | Compute **$0** when stopped | **EBS storage still bills** while stopped |

Scale-to-zero Fargate matches Chatticus's control-plane idle floor: an
organization that does no computer work should not pay for a vCPU. Long
GUI sessions or always-warm workplaces push cost toward EC2 + EBS or a
deliberately stopped instance with a warm cache — a manifold policy choice,
not a reason to abandon S3 snapshots.

---

## 6. Decisions already made

Future work should not silently reopen these decisions:

1. **A computer is a `computer_id`, not a host.** Fargate tasks, EC2
   instances, and Docker on a Mac are hosts.
2. **S3 is the one durable workplace store.** Snapshots are `snapshot.tar.gz`
   plus `manifest.json` for workspace and browser profiles only.
   *(Superseded 2026-09-03 as a design target -- EFS is the store; see §4.
   Still true of the running system. S3 keeps objects: artifacts, datasets,
   model weights, screenshots.)*
3. **One live disk per `computer_id`.** Two concurrent live disks are
   forbidden. *(Rescoped: the invariant belongs to the workspace, not the
   host, and under EFS it is enforced by POSIX locking rather than by a
   lease.)*
4. **Relocate is publish, then hydrate.** No live container migration.
   *(Superseded as a design target -- under EFS there is nothing to
   relocate.)*
5. **The v1 AWS computer image is Debian + Xvfb + Chromium on Fargate
   ARM64 0.25 vCPU / 512 MiB, scale to 0.**
6. **EFS is not implemented** and is not a second canonical store.
   *(Superseded 2026-09-03: EFS is the chosen store -- see §4. Still
   unimplemented. The "second canonical store" concern is answered by there
   being exactly one: EFS holds files, S3 holds objects.)*
7. **Omarchy is not the Fargate image; GUI desktop sessions belong on EC2
   (Antharchy), not in the slim container.**
8. **Agents should eventually declare work kind; the manifold chooses the
   host.** That API is not built yet.
9. **Do not dual-live-sync** one `computer_id` across Mac and cloud (no
   Mutagen-style two-writer model without publish/hydrate semantics).
10. **This memo does not authorize implementation** of the manifold, EFS,
    Antharchy AMI, or VPN local-VM hosting.

---

## 7. Open questions and next artifacts

1. Define the manifold API: work-kind enum, deadlines, publish policy, and
   idle-stop triggers.
2. Replace or extend the **120 s** summoned Fargate worker loop for
   **headless session** kind without breaking scale-to-zero economics.
3. Specify **Antharchy on EC2**: AMI lifecycle, stop/start vs always-on,
   EBS cache vs hydrate-from-S3 on boot, and how GUI sessions publish.
4. **Measure WAN NFS with FS-Cache** before implementing §4. Real
   `git status` and build times on an Antharchy VM over the tunnel are the
   load-bearing unknown of the EFS design.
5. Rank **local hosts** against AWS hosts in the scheduler without inbound
   ports -- and rank **accelerated batch separately**, since it needs no
   tunnel and carries by far the largest cost delta.
6. Measure **total cost per organization** across Fargate summons, stopped
   EC2 + EBS, and local hosts — tie to [Organizations](ORGANIZATIONS.md)
   budget notes.
7. Write Gherkin for manifold-visible behavior (declare kind → host
   provisioned → idle-stop publishes) before production code.

Suggested next deliverables:

- Manifold state machine and host-ranking table.
- EC2 + Antharchy spike (GUI session only).
- Cost worksheet: Fargate summon vs stopped EC2 vs local VM.
- Feature scenarios for work-kind declarations.

---

## 8. Continuation note for a future session

Start by reading this memo and [Computer snapshots](COMPUTER_SNAPSHOTS.md).
Do not reconstruct the argument from chat unless a detail is missing.

The most important boundary is **host vs workplace**: S3 snapshots and
`computer_id` semantics are already kernel; the open problem is **which
host class serves which work kind** and how idle-stop preserves the one-live-
disk rule.

Before quoting AWS prices or Fargate task sizes externally, recheck
`infra/lib/computer-stack.ts`, `computer/Dockerfile`, and the Test 2 spike
results. Update the verification date at the top when facts change.

---

## Change log

- **2026-09-03:** Initial durable memo from the September 3, 2026 design
  conversation, cross-checked against `develop` (Fargate task definition,
  snapshot layout, relocate rules, `CHATTICUS_HOST_WORKER_SECONDS` default,
  EFS-as-cache mentions, and org-scoped computer model).
