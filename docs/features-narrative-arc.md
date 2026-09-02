# Feature narrative arc

Gherkin in `features/` is the product story. A new reader should walk this
arc and understand Chatticus: who you are, which organization you act for,
how a message becomes a turn, who runs that turn, what the turn may do,
and how the system recovers when something breaks.

Behave still discovers files alphabetically. This document is the intended
reading order. Do not add a 1:1 pytest twin as a new file when the
capability already has a home. Later work may add `features/README.md` as
an index or number prefixes; do not rename the catalog in this pass.

Scenario order inside a feature: happy path, then variations, then errors.

## The story

Chatticus is named AI teammates on a computer you control. You sign in.
You belong to an organization (or you are waitlisted). You talk on a
channel. A message addressed to a bot starts a turn. A worker claims that
turn. The bot may answer without a computer, then escalate when it needs
one. A task grant names what the worker may touch. Consequential actions
stop for approval. If a worker disappears, the turn recovers. The web UI
and CLI are faces of the same front door.

## Chapter map

### 1. Sign-in and identity

Who is speaking, and how does the front door know?

| File | Role in the story |
|------|-------------------|
| `principal.feature` | Typed principal (user or worker). Enabled-member is default deny. Waitlist-safe and no-principal routes are explicit. |
| `cognito_principal.feature` | A Cognito id token becomes a user principal by verified email, not JWT claims. |
| `me.feature` | GET `/me` is the SPA membership snapshot: fail-closed, empty, pending, enabled. |

**Gaps (behavior still only in pytest)**

- `test_me_http.py`: GET `/me` without a verifier returns 503. Land in `me.feature`.
- `test_cognito_principal.py`: non-member email rejected; identity is email-keyed not `sub`. Land in `cognito_principal.feature`.
- `test_principal.py`: leftover route-marker cases already covered; keep Principal dataclass shape tests as pytest.

### 2. Membership and organizations

Which household do you belong to, and who may change it?

| File | Role in the story |
|------|-------------------|
| `organizations.feature` | Sign-in mints an identity. Create pending org, invite, accept, roles, suspend, reinstate. |
| `first_org_seed.feature` | Operator seed / Anthus backfill before enforcement. Enabling does not provision a computer. |
| `members_cli.feature` | Administrator CLI for list / enable / suspend / reinstate. |

**Gaps**

- `test_org_access.py`: enabled member allowed, non-member denied, worker must match tenant. Land in `organizations.feature` (access checks), not a new file.
- `test_org_records.py`: email-normalization helpers stay pytest. Lifecycle leftovers that match existing scenarios should be deleted.
- `test_org_seed.py` / `test_members_cli.py`: leftover twins of the two features above.

### 3. Org routing

Every request states which organization it is for.

| File | Role in the story |
|------|-------------------|
| `org_path_routing.feature` | `/orgs/{tenant_id}/...`. `X-Tenant-Id` is rejected. `/health`, `/auth`, `/me` stay outside the prefix. |

**Gaps**

- `test_org_path_routing.py`: HTTP cases are already here. Keep `org_path()` string helper as pytest.

### 4. Channels, messages, and turns

The conversation object, and what a human message starts.

| File | Role in the story |
|------|-------------------|
| `messages.feature` | Core chapter: post, enqueue, computerless answer, wait on browser, resume queues, idempotency, recycle, tenant isolation. Large; split later by capability if it keeps growing (channel store vs turn lifecycle vs recycle). |
| `bot_turns.feature` | A bot turn pins to the user's computer; duplicate names rejected. |
| `realtime_api.feature` | Turn-scoped SSE: watch, reconnect, cross-tenant deny, waiting gate. |
| `demo_cli.feature` | Same story from the CLI: post, watch tokens, reconnect, list in-flight. |

**Gaps**

- `test_messaging.py` is the largest leftover twin. Migrate remaining HTTP/SSE/recycle cases into `messages.feature` or `realtime_api.feature` in slices. Keep cursor/parser helpers as pytest.

### 5. Worker protocol

Who may run a turn, and how they authenticate.

| File | Role in the story |
|------|-------------------|
| `worker_registration.feature` | Register with tenant, capabilities, cost class; heartbeat; stale; replace. |
| `worker_credentials.feature` | Mint/rotate bearer; claim; reject missing bearer, invoke key, user principal, browser-as-worker. |
| `worker_tenant_ownership.feature` | Same `worker_id` may exist on two tenants. |
| `tenant_isolation.feature` | A worker only receives jobs for its tenant. |
| `job_routing.feature` | Prefer-local, stale local, `aws_only` / `local_only`, missing capabilities. |
| `cost_class_ranking.feature` | EC2 vs Fargate vs local ranking. |

**Gaps**

- `test_worker_auth.py`: bearer used on claim. Land in `worker_credentials.feature`.
- `test_worker_credentials.py`: leftover HTTP twins; keep `hash_worker_token` as pytest.

### 6. Computer and escalation

The computer is summoned, not assumed. Readiness is per capability.

| File | Role in the story |
|------|-------------------|
| `capability_gated_readiness.feature` | Work starts while the computer boots. |
| `mid_turn_computer_escalation.feature` | First computer tool continues the same turn. |
| `shared_computer.feature` | One user computer; shared files/browser; isolated bot memory. |
| `single_computer_start.feature` | One host-start claim; expire; reclaim; stale local. |
| `computer_host_start_generation.feature` | Host-start generation visible over HTTP. |
| `computer_host_readiness.feature` | Host ready / not ready. |
| `computer_ecs_host_starter.feature` | ECS starter from environment. |
| `computer_host_pull_worker.feature` | Host pull worker. |
| `computer_continuation_worker.feature` | Computer-capable continuation. |
| `computer_affinity.feature` | Affinity to the intended host. |
| `bot_turns.feature` | (also here) pin to the user's computer. |
| `computer_snapshots.feature` | Publish, relocate, hydrate, dirty-disk block. |
| `computer_snapshot_pack.feature` | Pack bytes, checksum, Mac hydrates what Fargate published. |
| `chromium_host_executor.feature` | Chromium host tool results. |

**Gaps**

- `test_computer_worker.py`, `test_computer_start.py`, host-boot/host-starter leftovers: merge remaining dispatch/nack stories into the computer-worker features; keep Dockerfile/image tests as pytest (`test_computer_image.py`).

### 7. Tasks and grants

What the turn is allowed to do.

| File | Role in the story |
|------|-------------------|
| `thin_task_item.feature` | Create / complete-with-evidence / close / tenant isolation. |
| `thin_task_http.feature` | Same over HTTP and through the model tool list. |
| `web_task_list.feature` | Web UI reads the same task API. |
| `task_authority_grant.feature` | A task enumerates a closed grant (tools, origins, recipients, scopes, egress). |
| `capability_sink_wiring.feature` | The grant is enforced at the file sink. HTTP PUT grant / POST workspace-read belongs **here**, not in a new `thin_grant_http.feature`. |
| `model_tool_loop_sinks.feature` | Same grant in the live model tool loop. |

**Gaps**

- `test_thin_grant_http.py`: HTTP grant + gated read. Merge into `capability_sink_wiring.feature` (happy HTTP read, then deny, then missing turn).
- `test_turn_capability_grant.py`: grant survives a recycled plane / durable store. Land in `capability_sink_wiring.feature` as durability, not a new file.
- `test_thin_task_http.py` / `test_thin_task_item.py`: leftover twins; keep OpenAI tool-call parsers as pytest.
- `test_capability_sinks.py` / `test_model_tool_loop_sinks.py`: leftover twins.

### 8. Approvals and containment

Consequential work stops for a human, or for an exact pre-auth.

| File | Role in the story |
|------|-------------------|
| `approvals.feature` | Send/publish require approval by default; tenant-scoped auto-review. |
| `exact_consequential_approval.feature` | Execute only the reviewed structured operation. |
| `consequential_binding_control.feature` | Connector + immutable approval; takeover for passwords. |
| `overnight_gated_action.feature` | Unattended consequential needs an exact human rule. |
| `unsupported_browser_action.feature` | Unbound browser "clicks" are not approval. |
| `page_content_authority.feature` | A page cannot expand the task. |
| `prompt_injection_containment.feature` | Injection fails at system sinks. |
| `browser_context_policy.feature` | Untrusted vs privileged browser contexts. |
| `v1_security_policy_exclusions.feature` | Named v1 non-claims (prompt/data split is mitigation; generic clicks unbound). |

**Gaps**

- `test_approval_binding.py`, `test_overnight_gated.py`, `test_unbound_browser_action.py`, `test_capability_policy.py`: leftover twins. Keep none that repeat these scenarios.

### 9. Recovery and durability

Crashes do not duplicate work or leave two actors.

| File | Role in the story |
|------|-------------------|
| `turn_attempts.feature` | Two workers, one logical turn; late resume. |
| `structured_journal_handoff.feature` | Typed journal; reclaim skips executed work. |
| `turn_recovery.feature` | Worker disappears; renew; waiting turns are not failed. |
| `turn_fault_injection.feature` | Crash at every durable boundary. |
| `escalation_failure_recovery.feature` | Computer escalation failure recovers. |

**Gaps**

- Matching pytest files are leftover twins. Keep scheduler name/format helpers (`test_turn_deadline_scheduler.py`) as pytest.

### 10. Spend

| File | Role in the story |
|------|-------------------|
| `vendor_ledger.feature` | Tokens and dollars (or null) per model call; frozen first-write rates. |

**Keep as pytest:** price-table/decimal helpers in `test_vendor_ledger.py` that are not scenario-shaped.

### 11. Web

| File | Role in the story |
|------|-------------------|
| `chattic_us_web.feature` | Product workspace: roster and chat over the same-origin API. |
| `web_task_list.feature` | (also chapter 7) household task list in the UI. |

### 12. Operator surfaces

| File | Role in the story |
|------|-------------------|
| `members_cli.feature` | (also chapter 2) |
| `demo_cli.feature` | (also chapter 4) |

## Merge and split notes

**Merge (same capability, do not add a file)**

- HTTP grant/read (`test_thin_grant_http.py`, draft `thin_grant_http.feature`) → `capability_sink_wiring.feature`.
- Org access checks (`test_org_access.py`) → `organizations.feature`.
- Worker bearer-on-claim (`test_worker_auth.py`) → `worker_credentials.feature`.
- Durable grant across recycle (`test_turn_capability_grant.py`) → `capability_sink_wiring.feature`.
- GET `/me` 503 (`test_me_http.py`) → `me.feature`.
- Cognito leftovers → `cognito_principal.feature`.

**Split later (file already too large for one capability)**

- `messages.feature`: channel store / computerless turn / recycle-durability are three capabilities in one file.
- Computer host cluster (`computer_host_*`, `computer_ecs_host_starter`) can stay split; they already match capabilities.

**Do not invent features for**

- Deploy/CDK script shape, Dockerfile/image layout, JWT/parser helpers, account-origin scan, live AWS/OpenAI evals.

## Migration order (this branch)

1. Fold HTTP grant/read into `capability_sink_wiring.feature`; delete `test_thin_grant_http.py`.
2. Org access → `organizations.feature`; delete `test_org_access.py`.
3. GET `/me` 503 → `me.feature`; delete `test_me_http.py` leftovers.
4. Org-path HTTP leftovers → delete from `test_org_path_routing.py` (keep helper).
5. Worker auth → `worker_credentials.feature`; delete `test_worker_auth.py`.
6. Durable grant → `capability_sink_wiring.feature`; delete `test_turn_capability_grant.py` behavior cases.
7. Cognito leftovers → `cognito_principal.feature`.
8. Worker-credentials HTTP leftovers; keep hash helper.
9. Thin-task HTTP leftovers; keep parsers.
10. Principal leftovers; keep dataclass shape tests.

Each step: extend the existing feature, reuse steps, behave + pytest green, remove the pytest twin, one commit.
