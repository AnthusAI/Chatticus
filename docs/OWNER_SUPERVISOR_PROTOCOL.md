# Owner supervisor protocol (Phase 2a contract)

> **Status:** CONTRACT. Nothing on this page is built. It is the exact interface
> that three people build against in parallel for Phase 2a of
> [Long-lived computer, file protocol and preview](LONG_LIVED_COMPUTER.md): the
> server routes and stores (A), the infrastructure and the credential broker (B),
> and the container supervisor (C). Every claim about today's code carries a
> `file:line` reference into `origin/develop` at the time of writing. Every
> statement about the proposal is the contract; a guess is labelled ASSUMPTION.
> The wire schemas are code, in
> [`host-protocol/src/supervisor.ts`](../host-protocol/src/supervisor.ts), with
> tests in `conversation/test/owner-supervisor-protocol-schema.test.ts`. Where
> this page and that file disagree, fix the page. The draft behavior is in
> [`features/computer_owner_long_lived.feature`](../features/computer_owner_long_lived.feature).

## 1. What Phase 2a is

A container that starts as the owner of the organization computer and then stays up
to serve more than one turn, switches itself off after 15 minutes without work, and
is replaced after at most 50 minutes. Nothing connects to it: it asks. The pieces:

```
ECS task (Fargate, init process)
  chatticus-watchdog     separate root process, no credentials, kills the supervisor if it wedges
  supervisor.mjs         root, PID 2+ : bootstrap, poll loop, hydrate, publish, stop
    holds in memory only: bootstrap token (until used), supervisor token, supervisor AWS credentials
    |
    `-- owner.mjs turn   root, one per turn: takeOverTurn, Pi session, tools
          env: this turn's gateway token and this turn's AWS credentials only
          shell commands: uid 2000 through chatticus-shell (unchanged)
```

Control plane side:

```
Starter Lambda     signs a bootstrap token, registers the owner worker, runs the task. Assumes no role.
Front Door Lambda  POST /host/owner/bootstrap | poll | stop-request. Decides dispatches. Invokes the broker.
Broker Lambda      OwnerCredentialBroker: the only principal that assumes the two owner roles.
```

### 1.1 Out of Phase 2a (reserved names, nothing implemented)

| Reserved | Phase | Rule until then |
| --- | --- | --- |
| `file_requests` in the poll response | 3 | Not in the schema. The response schema is not strict, so an old owner ignores a field a newer server adds; the request schema is strict. |
| `interactiveUntilAt` on the computer record, the 500 ms poll while a panel is open | 3, 4 | Not stored, not read. |
| `POST /host/owner/credentials` (refresh), credential providers in the child, `/run/chatticus/supervisor.sock` | 2b | In 2a the child gets its credentials once, in its environment, at fork. |
| Drain on `protocol_version` below `OWNER_MINIMUM_PROTOCOL_VERSION` (`drain_reason: "protocol_version"`) | 2b | The field is sent and stored. The server's minimum is 1, so nothing drains. `drain_reason` is a free string on the wire so a newer value never breaks an old owner. |
| Lifetime above 50 minutes; the external `OwnerLifetimeCheck` message chain with `ecs:StopTask` | 2b | See decision D3 below. |
| Background processes, previews, `stop_ok`, two concurrent turns | 4, 5 | The dispatch list is capped at one and `active_turns` at one. |

## 2. Decisions made in the contract

These resolve contradictions between sections of the design document, or fill
gaps. The owner accepted D1 to D6, D13 and D15 on 2026-10-12; the numbers below
are this page's own (C1, C2, ...) to avoid clashing with them.

| # | Decision | Why |
| --- | --- | --- |
| C1 | **The bootstrap exchange is Phase 2a and has its own route**, `POST /host/owner/bootstrap`, not a mode of the poll. The design document lists it under 2b (section 11) and says "on the first poll" (6.5). | The supervisor must not hold AWS keys in the task description in 2a, because the starter no longer assumes a role (C2). The exchange needs another audience, another response and a use-once rule; the poll stays idempotent and has one shape. The supervisor's first poll follows immediately. |
| C2 | **The starter assumes no role.** The broker is the only principal in both trust policies. Section 6.5's "the starter keeps its own right for the supervisor role" is dropped. | A starter-assumed credential would have to be placed in the RunTask overrides, which D15 removes. The broker issues the supervisor credentials at the exchange. |
| C3 | **The per-turn child holds no host token and calls no host route.** The dispatch carries a gateway token and AWS credentials only. The `owner-host` audience is deleted. | Verified: `takeOverTurn` talks to DynamoDB and S3 with its AWS credentials (`owner-deps.ts:77-102`) and to the model through the gateway; the five host routes were called by the wrapper (`owner.ts:279-332`: boot, publish, stopped, heartbeat), which is now the supervisor. A token the child does not use is a token that can leak. |
| C4 | **The per-turn role loses the snapshot statement.** `ComputerSnapshotObjects` (`owner-role-policy.json:20-25`) is removed. The five session tags stay. | The child no longer hydrates or publishes. After this change a leaked turn credential cannot read or overwrite the organization's disk. This is what makes the two tiers real. |
| C5 | **The supervisor never exports its credentials.** They live in memory and go to the AWS SDK as explicit credential objects. The task environment has no `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` or `AWS_SESSION_TOKEN`. | A child built from the container environment could otherwise inherit them. The child is spawned with an explicit allow-list (section 9.2). |
| C6 | **Drain is decided by the server.** The owner never starts a lifetime drain on its own clock. The server answers `drain: true` once `now - ownerStartedAt >= 3000 s`. | One clock, no skew argument. The owner's independent backstop is the watchdog (section 9.6). |
| C7 | **The stop request has three reasons**: `idle` (full veto predicate), `lifetime` (accepted only while the server is draining; ignores parked work), `unhealthy` (the owner is failing; always approved). A drain that ignored parked work is required: parked turns wait for an owner that will never dispatch them, and the stopped report starts the next owner (`host.ts:124`). | Without it a draining owner would be vetoed by the very turns it cannot serve. |
| C8 | **`stop_ok` is dropped from the poll response.** | Redundant: the stop request is its own route. |
| C9 | **Drain grace is 300 seconds, not the 10 minutes of 6.8.** | Credentials last 3600 seconds and no renewal exists in 2a. 3000 s lifetime + 300 s grace + 120 s final publish = 3420 s < 3600 s. |
| C10 | **The in-container watchdog (a separate process) is Phase 2a. The external SQS chain with `ecs:StopTask` of 6.8 moves to 2b.** | Section 11 puts "the watchdog" in 2a and 6.8 describes the external one. At a 50 minute cap the exposure of a wedged owner is about 1 cent an hour for a bounded time on one development computer. The chain needs a new permission and a new message type and is load-bearing only when the cap rises to 8 hours. See open question Q2. |
| C11 | **Cadence while serving, draining and stopping is 5000 ms**, not 1000 ms. Idle follows the 1000/3000/10000 tiers by time since idle began. The owner polls immediately when a child exits. | One turn at a time (D5) means nothing can be dispatched while serving; a 1 s poll buys nothing. |
| C12 | **Live proof "within 5 seconds" becomes "within 15 seconds"** (up to 10 s to the next poll, up to 5 s to start the child) for a computer idle for more than 5 minutes; within 8 seconds up to 5 minutes. | 6.1 sets the slow tier to 10 s. Two messages five minutes apart land on the boundary. |
| C13 | **The poll cost estimate is revised**: one conditional write to the worker item plus two or three reads. About 0.07 cents an hour at 10 s, 0.7 cents an hour at 1 s (ASSUMPTION: on-demand prices not re-verified). The design said 0.027 cents an hour; that counted reads only. | Still under a tenth of the computer's hourly cost at the slow rate. Writes happen only on change except the worker heartbeat. |
| C14 | **Quiet and periodic publish never run while a child runs.** They run in the state `publishing`, 30 seconds after a child exits and every 600 seconds while idle, only if the index scan says the disk changed. | The 512 MiB task cannot be assumed to hold the pack stream and a Pi turn (design risk 1, unmeasured). 6.6's "every 10 minutes during a busy period" is therefore "at the next gap". |
| C15 | **`owner_turn_finished` is replaced by `owner_child_exited`** (the supervisor sees an exit code, not an outcome). | The child already writes the outcome (`owner_exit`, `owner.ts:251-262`). |
| C16 | **After each child exits, the supervisor kills every process of uid 2000.** | Background processes are Phase 4. Until then a command that backgrounds itself must not survive its turn unnoticed in a container that now lives for 50 minutes. See Q3. |
| C17 | **The supervisor fences itself** after 25 seconds without a successful poll: kill the child, publish nothing, exit 4. | The control plane counts an owner dead at 30 seconds (`workers.ts:24`) and may start another on the last snapshot. Two writers on one disk is worse than losing unpublished work. See Q1. |
| C18 | **`already_serving` uses its own predicate**, `liveOwnerOf`, not `assignTurn`. `ensureHostForParkedTurn` also consults it first. | `assignTurn` rejects a worker whose snapshot is stale (`workers.ts:207-218,242`), which is true for the whole of a hydrate, so a hydrating owner would look absent and a second start would claim a new generation. |
| C19 | **`POST /host/heartbeat` no longer accepts an owner token.** The poll is the heartbeat. The route stays for customer-account host workers. | One path. |
| C20 | **The 422 body of an owner route carries `code: "invalid_request"`** like every other owner refusal. | The supervisor branches on `code`. |

## 3. Constants

All in `host-protocol/src/supervisor.ts`. Nothing is read from the environment; tests inject their own clock and
timeouts through options.

| Constant | Value | Used by |
| --- | --- | --- |
| `OWNER_PROTOCOL_VERSION` | 1 | supervisor sends; server stores |
| `OWNER_MINIMUM_PROTOCOL_VERSION` | 1 | server (drain reserved for 2b) |
| `OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS` | 300 | starter |
| `OWNER_CREDENTIAL_LIFETIME_SECONDS` | 3600 | broker (tokens and `DurationSeconds`) |
| `OWNER_DISPATCH_LEASE_SECONDS` | 30 | server |
| `OWNER_POLL_FAST/MEDIUM/SLOW_MILLISECONDS` | 1000 / 3000 / 10000 | server |
| `OWNER_POLL_FAST/MEDIUM_WINDOW_SECONDS` | 60 / 300 | server |
| `OWNER_POLL_BUSY_MILLISECONDS` | 5000 | server (serving, draining, stopping) |
| `OWNER_POLL_STARTING_MILLISECONDS` | 2000 | server (booting, hydrating, publishing) |
| `OWNER_IDLE_TIMEOUT_SECONDS` | 900 | supervisor |
| `OWNER_STOP_RETRY_SECONDS` | 30 | supervisor after a veto |
| `OWNER_MAX_LIFETIME_SECONDS` | 3000 | server (drain), watchdog |
| `OWNER_DRAIN_GRACE_SECONDS` | 300 | supervisor, watchdog |
| `OWNER_FINAL_PUBLISH_BUDGET_SECONDS` | 120 | watchdog |
| `OWNER_POLL_SILENCE_FENCE_SECONDS` | 25 | supervisor |
| `OWNER_CHILD_FAILURE_LIMIT` | 3 | supervisor |
| `OWNER_QUIET_PUBLISH_SECONDS`, `OWNER_PERIODIC_PUBLISH_SECONDS` | 30, 600 | supervisor |
| `OWNER_WATCHDOG_TERMINATE/KILL_SECONDS` | 3300 / 3420 | watchdog |
| `OWNER_WATCHDOG_STALE_SECONDS`, `OWNER_WATCHDOG_CHECK_SECONDS` | 180, 15 | watchdog |
| `OWNER_ERROR_STATUS` | code to status map | server, tests |
| `OWNER_CHILD_ENVIRONMENT_NAMES`, `OWNER_CHILD_FORBIDDEN_ENVIRONMENT_NAMES` | name lists | supervisor, tests |

The heartbeat window stays `DEFAULT_HEARTBEAT_TIMEOUT_SECONDS` = 30 (`workers.ts:24`).
`OWNER_CREDENTIAL_LIFETIME_SECONDS` currently lives in `owner-start-driver.ts:28`; moving it here also keeps the
image bundle from importing the starter (the bundle guard forbids `owner-start-driver`,
`conversation/test/computer-image-structure.test.ts`).

## 4. Identities and tokens

All tokens are `ct1.<claims>.<signature>` (HMAC-SHA-256 over `ct1.<claims>`, claims as base64url JSON), signed with
the existing model gateway signing key secret (`ModelGatewaySigningKey`, `control-plane-stack.ts:379-402`;
`session-token.ts:59-63`). The claim keys are camelCase like today's.

| Token | Audience | Claims | Lifetime | Minted by | Accepted by |
| --- | --- | --- | --- | --- | --- |
| Bootstrap | `owner-bootstrap` | `audience`, `tenantId`, `computerId`, `ownerId`, `startGeneration`, `issuedAtSeconds`, `expiresAtSeconds` | 300 s, once | the starter | `POST /host/owner/bootstrap` only |
| Supervisor | `computer-owner` | the same seven; no bot, channel or turn | 3600 s | the broker (`purpose: supervisor`) | the owner routes (section 5), nothing else |
| Gateway | `model-gateway` | unchanged: `tenantId`, `botId`, `turnId`, `ownerId`, `startGeneration`, `expiresAtSeconds` | 3600 s | the broker (`purpose: turn`) | the model gateway only |

The claims schemas are `ownerBootstrapTokenClaimsSchema` and `computerOwnerTokenClaimsSchema` (strict: a supervisor
token with a `turnId` is malformed). `SessionTokenAudience` becomes `"model-gateway" | "computer-owner" |
"owner-bootstrap"` (`session-token.ts:8`); `owner-host` is deleted. `SessionTokenClaims` becomes a union by audience;
`verifySessionToken` takes the audience and returns the claims typed for it (`session-token.ts:100-115`). A token of
one audience is refused on the surface of another with 401 `invalid_credential` (`audience` refusal reason).

`ownerId` is `owner-<uuid>`, generated by the starter per start (`computer-starter.ts:122`). It is also the worker id
and the claim identity of every child (`CONTAINER_OWNER_WORKER_ID` is no longer used by the container;
`owner.ts:18`).

### 4.1 AWS roles

Both roles trust only the broker's execution role, with `sts:AssumeRole` and `sts:TagSession`, maximum session 3600
seconds, and tag conditions that make a session without the full tag set, or with any other key, impossible. The
pattern is `ownerSessionTagConditions()` (`infra/lib/owner-role-policy.ts`, the `Null` plus `ForAllValues:StringEquals
aws:TagKeys` pair; the `Null` half is what stops a session with no tags).

| Role | Session tags (exactly) | Permissions |
| --- | --- | --- |
| `ComputerOwnerScopedRole` (per turn; exists, `computer-host-start.ts:417`) | `tenant`, `bot`, `channel`, `computer`, `turn` | `conversation/src/gateway/owner-role-policy.json` **minus** `ComputerSnapshotObjects` (C4) |
| `ComputerSupervisorRole` (new) | `tenant`, `computer` | the file below |

`conversation/src/gateway/supervisor-role-policy.json` (new; infra reads it as data like `owner-role-policy.json`, and
the scenarios evaluate the same file):

```json
{
	"statements": [
		{
			"Sid": "SnapshotObjects",
			"Effect": "Allow",
			"Action": ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
			"Resource": ["{{snapshotBucketArn}}/tenants/${aws:PrincipalTag/tenant}/computers/${aws:PrincipalTag/computer}/*"]
		}
	]
}
```

One statement. `PutObject` covers `CreateMultipartUpload`, `UploadPart` and `CompleteMultipartUpload`; the abort is a
separate action and the streaming pack calls it (`snapshot/s3.ts:78`). No delete, no `ListBucket` (verified: `s3.ts`
imports no list command; the per-turn role has had the same shape), no DynamoDB, no Pi sessions bucket, no Secrets
Manager, no SSM, no `sts`. ASSUMPTION: a read of a missing snapshot key returns AccessDenied without `ListBucket`; the
code already checks `snapshot_uri` before reading (`disk-lifecycle.ts:118`) and catches errors in the change check
(`disk-lifecycle.ts:90-99`).

The broker passes tag values that `ownerSessionTags` accepts (`session-tags.ts:21-67`): letters, digits, `_ . : -`,
at most 256 characters. A new `supervisorSessionTags({ tenantId, computerId })` in the same file builds the two tags
and throws `OwnerSessionTagError` the same way. The starter calls it before it starts a task, so an unsafe id stops
the start early, as it does today (`owner-start-driver.ts:155-167`).

## 5. Routes

All paths are under `/orgs/{tenant_id}/host`. Request and response schema names are exports of `host-protocol/src/supervisor.ts`
unless marked existing (`host-protocol/src/schemas.ts`).

| Method and path | Audience (`declareRoute`) | Authentication | Request | Response (200) | Refusals |
| --- | --- | --- | --- | --- | --- |
| `POST /owner/bootstrap` | `owner-bootstrap` | `Authorization: Bearer <bootstrap token>` | `ownerBootstrapRequestSchema` | `ownerBootstrapResponseSchema` | 401 `invalid_credential`; 403 `wrong_organization`, `credential_mismatch`, `stale_generation`, `owner_not_registered`; 409 `bootstrap_already_used`; 422; 503 `credentials_unavailable` |
| `POST /owner/poll` | `computer-owner` | supervisor token | `ownerPollRequestSchema` | `ownerPollResponseSchema` | 401; 403 `wrong_organization`, `credential_mismatch`, `stale_generation`, `not_current_owner`; 409 `stale_poll`; 422 |
| `POST /owner/stop-request` | `computer-owner` | supervisor token | `ownerStopRequestSchema` | `ownerStopResponseSchema` (a veto is a 200) | 401; 403 as the poll; 422 |
| `GET /computer` | `worker` (existing) | worker bearer **or** supervisor token | none | `hostComputerSchema` (existing) | 401, 403 as the poll |
| `POST /computer/state` | `worker` (existing) | worker bearer **or** supervisor token | `computerStateRequestSchema` (existing, unchanged) | `hostComputerSchema` | 401, 403 as the poll; 403 for a generation the token does not own (existing, `host.ts:107-114`) |
| `POST /snapshot/hydrated` | `worker` (existing) | worker bearer **or** supervisor token | `snapshotHydratedRequestSchema` | `hostStatusResponseSchema` | 401, 403 as the poll |
| `POST /snapshot/published` | `worker` (existing) | worker bearer **or** supervisor token | `snapshotPublishedRequestSchema` | `hostStatusResponseSchema` | 401, 403 as the poll |
| `POST /heartbeat` | `worker` (existing) | worker bearer only | existing | existing | owner tokens are refused |
| `POST /actions/*` | `worker` (existing) | worker bearer only | existing | existing | owner tokens are refused |
| `POST /orgs/{t}/model-gateway/v1/responses` | `model-gateway` (existing) | gateway token | existing | existing | unchanged |

`RouteAudience` (`route-audience.ts:6`) gains `computer-owner` and `owner-bootstrap`. Decision on the five existing
routes (F): the **supervisor token** opens the four of them the supervisor calls (computer, state, hydrated,
published), and `heartbeat` is removed from the owner list (C19). The per-turn child has no host token at all (C3).
`OWNER_HOST_ROUTES` (`owner-host-auth.ts:23-29`) becomes `OWNER_COMPUTER_ROUTES`: the four existing routes plus
`POST /owner/poll` and `POST /owner/stop-request`; `POST /owner/bootstrap` is matched separately for the bootstrap
audience.

Every error body from a supervisor-token or bootstrap route is `{ "detail": string, "code": OwnerErrorCode }`
(`ownerErrorSchema`; codes and statuses in `OWNER_ERROR_STATUS`). The `detail` text never echoes a token or a claim.
The existing strings stay where they exist (`invalid owner credential`, `owner credential is not valid for this
organization`, `owner credential is not valid for this host start generation`).

### 5.1 Authentication of a supervisor-token request

Replaces `authenticateOwnerHostRequest` (`owner-host-auth.ts:119-140`), still in the middleware that runs before the
invoke key check (`app.ts:159-175`; the key check at `app.ts:176-197` is skipped for a verified owner principal, as
today). Order, first failure wins:

1. The bearer starts with `ct1.` and `(method, path)` is an owner computer route: else the request is not an owner
   request and falls through to the invoke key gate. (An owner-only route reached without a principal is refused by
   its handler with 403 `not_current_owner`, so the invoke key alone never opens `/owner/*`.)
2. Verify signature, expiry and audience `computer-owner`: 401 `invalid_credential`. A gateway or bootstrap token
   presented here is this refusal.
3. Path tenant equals `claims.tenantId` and decodes to itself: 403 `wrong_organization`.
4. Read the computer record. Absent, or its id is not `claims.computerId`: 403 `not_current_owner`.
5. `computer.hostStartGeneration` is not `claims.startGeneration`: 403 `stale_generation`.
6. `computer.ownerId` is not `claims.ownerId`, or `computer.ownerGeneration` is not `claims.startGeneration`: 403
   `not_current_owner`. One exception, the **stopped replay**: `POST /computer/state` with `stopped: true` and
   `start_generation` equal to the claims, on a record that is `stopped`, whose `ownerGeneration` equals the claims and
   whose `ownerId` is absent, is accepted and answered 200 with the record. It makes the stopped report safe to
   repeat when its response was lost; it changes nothing.
7. The organization must still be enabled (`enforceOwnerPrincipal`, `worker-principal.ts:65-68`).

The principal is `{ tenantId, computerId, ownerId, startGeneration }`, remembered per request as today
(`owner-host-auth.ts:83-95`). `workerId` of the principal is `ownerId`.

The two snapshot routes and the state route additionally keep their own checks (`host.ts:107-114` for stopped). With a
supervisor principal, steps 5 and 6 already guarantee the live generation owns the call, which closes the hole where a
returned zombie owner could publish over a newer owner's snapshot.

### 5.2 `POST /owner/bootstrap`

Request (`ownerBootstrapRequestSchema`, strict): `owner_id` string, `generation` integer > 0, `protocol_version` integer > 0.

Response: `computer_id`, `supervisor_token`, `supervisor_token_expires_at` (ISO 8601 UTC), `aws_credentials`
`{ access_key_id, secret_access_key, session_token, expires_at }`.

Handler order:

1. Verify the bootstrap token (audience `owner-bootstrap`, signature, expiry): 401 `invalid_credential`.
2. Path tenant equals `claims.tenantId`: 403 `wrong_organization`.
3. `owner_id` equals `claims.ownerId` and `generation` equals `claims.startGeneration`: 403 `credential_mismatch`.
4. Computer exists, `computerId` equals `claims.computerId` and `hostStartGeneration` equals `claims.startGeneration`:
   else 403 `stale_generation` (a newer start already claimed a generation; this owner must not run).
5. The worker `ownerId` is registered for this computer (the starter registered it): else 403 `owner_not_registered`.
6. Organization enabled.
7. Ask the broker for `purpose: supervisor`, `authorization` = the bootstrap token. Broker unreachable or refusing:
   503 `credentials_unavailable`, **the token is not consumed**, so the supervisor may retry inside its five minutes.
8. Consume and record in one conditional update of the computer record. Condition:
   `host_start_generation = :g AND (attribute_not_exists(owner_generation) OR owner_generation < :g)`.
   Set `owner_id`, `owner_generation = g`, `owner_started_at = now`, `owner_protocol_version`; remove
   `idle_since_at`, `owner_stop_approved_at` and every `dispatch_*` attribute. A failed condition is 409
   `bootstrap_already_used`; the minted credentials are discarded unseen. Mint-then-consume means a replay costs one
   STS call and delivers nothing.
9. Set the worker's `lastHeartbeatAt = now` and remove its `pollSequence` (the first poll has sequence 0).
10. Respond 200.

`ownerGeneration` is never cleared (not by a stop, not by a settle), so a bootstrap token of a finished generation can
never be exchanged again. A lost bootstrap response burns the token; the supervisor exits 6 and the lost-owner path
starts a new generation (the worker is registered with a fresh heartbeat, so it is "healthy" for 30 seconds, then
absent; the start lease is 60 seconds, `computers.ts:27`).

### 5.3 `POST /owner/poll`

Request (`ownerPollRequestSchema`, strict):

| Field | Type | Meaning |
| --- | --- | --- |
| `owner_id` | string | Must equal the token's owner (403 `credential_mismatch`). |
| `generation` | integer > 0 | Must equal the token's `startGeneration` (403 `credential_mismatch`). |
| `protocol_version` | integer > 0 | Stored in `ownerProtocolVersion`. |
| `sequence` | integer >= 0 | Per owner, starts at 0, +1 after each poll whose answer was read. A retry after a timeout repeats the same value. |
| `state` | `booting`, `hydrating`, `idle`, `publishing`, `serving`, `draining`, `stopping` | See 10.1. |
| `active_turns` | array of `{ turn_id, dispatch_id }`, at most 1 | `serving` has exactly one; `booting`, `hydrating`, `idle`, `publishing`, `stopping` have none; `draining` has zero or one. |
| `memory_used_percent` | integer 0 to 100, optional | Container memory in use. Logged by the Front Door at 85 or more (`owner_memory_high`); stored nowhere. |

Response (`ownerPollResponseSchema`): `dispatches` (0 or 1 `ownerDispatchSchema`), `drain` boolean, `drain_reason`
(present exactly when `drain`; `"lifetime"` in 2a), `next_poll_ms` (250 to 60000). A draining answer has no dispatch.

Dispatch (`ownerDispatchSchema`):

| Field | Type | Meaning |
| --- | --- | --- |
| `dispatch_id` | string | Unique per offer. |
| `turn_id`, `bot_id`, `channel_id` | string | From the turn record. |
| `user_id` | string | The turn's `promptAuthorId`. A turn without one is skipped and logged (`owner_dispatch_skipped reason=no_prompt_author`), as `ensureHostForParkedTurn` throws for it (`park.ts:114-116`). |
| `action_id` | string | The parked computer action. |
| `waiting_since` | ISO or null | `turn.waitingSince`; the supervisor computes `queue_wait_ms` from it. |
| `lease_expires_at` | ISO | Offer time + 30 s. |
| `attempt` | integer >= 1 | 1 for the first offer of this turn's action, +1 per re-offer after a lapse. |
| `gateway_token` | string | `model-gateway` token for this turn and this owner. |
| `aws_credentials` | object | The per-turn credentials: role `ComputerOwnerScopedRole`, tags `tenant`, `bot`, `channel`, `computer`, `turn`. |
| `expires_at` | ISO | Expiry of both the gateway token and the credentials. |

There is no host token (C3).

Handler order (after the authentication of 5.1):

1. Validate the body (422 `invalid_request`). `owner_id` and `generation` equal the token's (403 `credential_mismatch`).
2. **Sequence and heartbeat.** One conditional `UpdateItem` on the worker item `ownerId`: set `last_heartbeat_at = now`,
   `poll_sequence = :seq`, `poll_state = :state`; condition `attribute_not_exists(poll_sequence) OR poll_sequence <= :seq`.
   A failed condition is 409 `stale_poll` (a delayed duplicate of an older poll). Equal sequence is a retry and
   proceeds. This is the only unconditional-rate write.
3. **Computer writes, on change only.** `ownerProtocolVersion` when it differs. `idleSinceAt`: on `state: idle` with
   none, set to now; on `serving` or `draining` with one, remove it. `publishing`, `booting`, `hydrating`, `stopping`
   leave it.
4. **Settle lost actions.** Call `expireLostComputerActions` and `resumeTurnForAction` for each action it answered, as the
   starter does (`computer-start.ts:98-100`). A claimed action whose lease ran out (a child that died) is released or
   answered "interrupted" here and not only by a probe.
5. **Drain.** `drain = (now - ownerStartedAt >= OWNER_MAX_LIFETIME_SECONDS)`, `drain_reason = "lifetime"`. A stop
   already approved (`ownerStopApprovedAt` set) also answers no dispatch; `drain` stays whatever the clock says.
6. **Dispatch**, only if `state === "idle"`, `active_turns` is empty, `drain` is false and no stop is approved
   (section 6.3).
7. **Cadence** (section 6.4). Respond 200.

### 5.4 `POST /owner/stop-request`

Request (`ownerStopRequestSchema`, strict): `owner_id`, `generation`, `reason` (`idle`, `lifetime`, `unhealthy`),
`active_turns` (at most 1).

Response (`ownerStopResponseSchema`): `{ "approved": true }` or `{ "approved": false, "reason": R }`, `R` one of
`work_pending`, `dispatch_pending`, `turn_active`, `not_draining`. Always 200 after the authentication of 5.1.

Predicate ("no pending work"), evaluated in this order. `parkedWork` is the **same function the poll uses to choose
dispatches**: the open actions of this computer with status `requested` whose turn is `active`, `waitingFor !== null`
and `pendingComputerTool.actionId` equal to the action (the query of `startOwnerForParkedTurns`, `park.ts:153-163`,
extracted and shared; requested actions of terminal turns do not count, otherwise one orphan would veto every idle stop
forever).

| Reason | Approve when |
| --- | --- |
| `idle` | (1) `parkedWork` is empty, else `work_pending`, or `dispatch_pending` when one of them has an unexpired dispatch lease; (2) no turn is live: the turn of `dispatchTurnId` is not (`active` and `claimedBy == ownerId` and lease unexpired), and `active_turns` is empty, else `turn_active`. |
| `lifetime` | The server is draining (`now - ownerStartedAt >= OWNER_MAX_LIFETIME_SECONDS`), else `not_draining`. Parked work and a live turn do not veto: the owner reports it killed its child, the lost-owner recovery settles the turn, and the stopped report starts the next owner. |
| `unhealthy` | Always. |

On approval, in one conditional update: `owner_stop_approved_at = now`. Condition: the owner is the live owner and
`dispatch_id` is still the value that was read when the predicate was judged. A failed condition re-judges, at most
three times, then answers `dispatch_pending`. Because the offer (6.3 step 5) is conditioned on
`attribute_not_exists(owner_stop_approved_at)` and the approval on the dispatch not having changed, an offer and an
approval on the same record cannot both win: the veto cannot lose a wake-up and an approved owner is never handed a turn.

A turn that parks after the approval waits: the owner is still the live owner (`liveOwnerOf`), so no start job is
published (`park.ts:126`, as extended in 6.5), and the stopped report starts the next owner (`host.ts:124`). This is the
rule of 6.4 of the design, unchanged: "stop requested" is not "no host".

## 6. Server behavior

### 6.1 Records

`Computer` (`store/codecs/computer.ts:9-34`) gains optional fields; attribute names in the table. Written by the
conditional updates named, all in the Messaging store (`dynamo-messaging-store.ts`, next to `claimHostStartGeneration`
at `:530`). The per-turn role's `MessagingWritable` statement still allows `T#computer#record` (`owner-role-policy.json:55`)
because the child marks the disk dirty (`local-computer-tools.ts:356,421`); the new fields are written by the Front Door.

| Field (attribute) | Type | Written by | Cleared by |
| --- | --- | --- | --- |
| `ownerId` (`owner_id`) | string | bootstrap | `setComputerStopped(true)` (`computers.ts:92`); `settleLostComputerHost` (`dynamo-messaging-store.ts:555`); `claimHostStartGeneration` (`:530`) |
| `ownerGeneration` (`owner_generation`) | integer | bootstrap | never |
| `ownerProtocolVersion` (`owner_protocol_version`) | integer | bootstrap, poll on change | with `ownerId` |
| `ownerStartedAt` (`owner_started_at`, epoch seconds) | date | bootstrap | with `ownerId` |
| `idleSinceAt` (`idle_since_at`) | date | poll | poll, with `ownerId` |
| `ownerStopApprovedAt` (`owner_stop_approved_at`) | date | stop request | with `ownerId`, bootstrap |
| `dispatchId`, `dispatchTurnId`, `dispatchActionId`, `dispatchAttempt`, `dispatchLeaseExpiresAt` | string, string, string, integer, date | offer | with `ownerId`, bootstrap (a dispatch is never cleared on claim; it is evaluated) |

`Worker` (`store/codecs/worker.ts:9-18`) gains `pollSequence` (`poll_sequence`) and `pollState` (`poll_state`). The
worker item is the liveness record of the owner: one worker id per owner id, registered by the starter before the task
starts (`computer-starter.ts:123-130`, `owner-start-driver.ts:182-187`), capabilities `cpu, computer`, cost class
`local`, `computerId` set. The bearer token `registerWorker` returns is discarded, as today; it is never given to
anyone. The worker items of finished owners accumulate (security review finding 8); out of scope.

### 6.2 The liveness predicate

```
liveOwnerOf(computer, worker, now, timeoutSeconds) =
	computer.ownerId !== undefined
	and computer.ownerGeneration === computer.hostStartGeneration
	and worker !== null and worker.workerId === computer.ownerId
	and worker.computerId === computer.computerId
	and now - worker.lastHeartbeatAt <= timeoutSeconds
```

`timeoutSeconds` is the existing 30 (`workers.ts:24`; the same window `healthyWorkers` applies at `workers.ts:144-157`).
It does not look at `stopped`, hydration, or the owner's state: a booting, hydrating, serving, draining or stopping
owner of the current generation is live (C18). A customer-account host worker never sets `ownerId`, so the predicate is
false for it and `assignTurn` alone decides, unchanged.

### 6.3 Dispatch lifecycle and idempotence

At most one dispatch exists per computer (D5). It lives in the five `dispatch*` fields.

Choosing (poll step 6): `parkedWork` (5.4) gives candidates oldest first. Let `current` be the stored dispatch.

1. If `current` exists and its turn is still parked on its action (`turn.waitingFor !== null`,
   `pendingComputerTool.actionId === dispatchActionId`, action `requested`) and `dispatchLeaseExpiresAt > now`:
   **re-offer the same dispatch** (same `dispatch_id`, same `attempt`, same `lease_expires_at`) with credentials freshly
   issued by the broker. This answers a poll whose previous response was lost.
2. Else, take the first candidate (the dispatch of a lapsed lease is simply the first candidate again). Before offering,
   apply the spend ceiling (`computerWorkPauseReason`, `organization-spend.ts`): if work is paused, answer the open
   actions of that turn as denied and resume the turn exactly as the starter does (`computer-start.ts:131-138`,
   `deniedActionResult`), then take the next candidate. A live owner must not bypass the ceiling that a start enforces.
3. A candidate whose turn has no `promptAuthorId` is skipped and logged.
4. Ask the broker for `purpose: turn` with the candidate's `turn_id`, `bot_id`, `channel_id`, authorization = the
   supervisor token. Broker failure (any `ok: false`, unreachable): log `owner_dispatch_failed code=<code>`, answer the
   poll 200 with no dispatch. The owner stays healthy; the next poll tries again.
5. Write the dispatch in one conditional update: owner is live, `attribute_not_exists(owner_stop_approved_at)`, and
   `dispatch_id` equals the value read in step 1 (or does not exist). `attempt` is `previous attempt + 1` when the new
   dispatch is for the same `action_id` as the lapsed one, else 1. A lost race answers no dispatch.
6. Answer with the dispatch.

States (derived, never stored as a status):

| State | Meaning | Becomes |
| --- | --- | --- |
| `offered` | stored, lease unexpired, turn still parked on the action | `claimed`, `expired` or `void` |
| `claimed` | the turn's waiting was cleared by `takeOverTurn` (`computer-owner.ts:80-87` calls `resumeTurnForAction`; the claim follows in `executeTurn`, `computer-owner.ts:88`). **The child's takeover is the acknowledgement.** | `finished` |
| `finished` | the supervisor reports `idle` with no active turn after having served it; the child exited | next offer |
| `expired` | lease lapsed with the turn still parked | a new offer, `attempt + 1`, new `dispatch_id` |
| `void` | the turn is no longer parked on that action for another reason (answered, denied, failed by a probe) | next candidate |

The re-offer rule makes a retried poll safe; the lapse rule bounds a child that never started (fork failure, crash
before claim) by 30 seconds, well inside the 15 minute waiting limit (`probes.ts:18`). Two owners cannot both receive a
dispatch for one turn because only one owner is ever live (6.2); two children for one turn cannot both claim it
(`claimTurn` is a compare-and-set, `domain/turns.ts:332`).

### 6.4 Cadence

`next_poll_ms`:

| Condition | Value |
| --- | --- |
| state `booting`, `hydrating`, `publishing` | 2000 |
| state `serving`, `draining`, `stopping` | 5000 |
| state `idle`, `now - idleSinceAt < 60 s` | 1000 |
| state `idle`, `< 300 s` | 3000 |
| state `idle`, otherwise | 10000 |

The supervisor polls again at once (no wait) when a child exits, and honors `next_poll_ms` otherwise.

### 6.5 Start check (E): `already_serving`

In `handleComputerStartJob` (`computer-start.ts:89-130`), after `expireLostComputerActions` (`:98`) and before
`requestComputerHostStart` (`:103`), read the computer and the worker `computer.ownerId` and test `liveOwnerOf`. If it
holds, return and acknowledge the job:

```
{ kind: "already_serving", hostStartGeneration: computer.hostStartGeneration, ownerId: computer.ownerId }
```

`ComputerStartOutcome` (`computer-start.ts:62-65`) gains that variant. No generation is claimed, no task is started,
no lease is touched, `markHostStartDispatched` is not called, and the line `computer_start_already_serving` is written
(tenant, turn, owner, generation). The check also runs for a start job caused by a probe re-ask
(`park.ts:300-302`).

`ensureHostForParkedTurn` (`park.ts:113-140`) consults `liveOwnerOf` first and returns `false` without a job when it
holds, then falls through to `assignTurn` unchanged (so customer-account hosts are unaffected). Both checks use the
same function.

**An owner that is draining or stopping is still live.** A start job that arrives is acknowledged as `already_serving`
and dropped. The parked turns wait. When the owner reports stopped, `setComputerStopped(true)` clears `ownerId`,
`releaseHostStartLease` ends the lease and `startOwnerForParkedTurns` publishes one start job per parked turn
(`host.ts:119-125`); the starter shares one start between them. If the owner never reports, its heartbeat lapses in 30
seconds, `liveOwnerOf` turns false, and the next probe of each waiting turn (at most 60 seconds, `probes.ts:190`) publishes a start job that now proceeds. A turn waits at most 15
minutes (`probes.ts:18`).

### 6.6 What the stopped report does

`POST /computer/state` with `stopped: true` from a supervisor principal (`host.ts:103-133`): the generation check of
`:107-114` is unchanged. `setComputerStopped(true)` (`computers.ts:92-104`) additionally removes `ownerId`,
`ownerProtocolVersion`, `ownerStartedAt`, `idleSinceAt`, `ownerStopApprovedAt` and the `dispatch*` fields and keeps
`ownerGeneration`. Then `releaseHostStartLease` and `startOwnerForParkedTurns` run as today. `settleLostComputerHost`
and `claimHostStartGeneration` remove the same fields. A dead idle owner that never made the disk dirty is not settled
(the settle condition requires `disk_dirty` or a writer lock, `dynamo-messaging-store.ts:555-583`); that is fine, because
`liveOwnerOf` is false after 30 seconds and the next start claims a generation and overwrites the owner fields at
bootstrap (step 8 of 5.2).

## 7. The credential broker

`OwnerCredentialBroker` is a Lambda in the ControlPlane stack, source
`conversation/src/lambdas/owner-credential-broker.ts` (ARM64, Node 22, 256 MB, 15 s). It is invoked synchronously
(`InvocationType: RequestResponse`) by the Front Door through `LambdaClient`; nothing else may invoke it
(`lambda:InvokeFunction` is granted to the Front Door role only).

**Holds:** the signing key secret (`CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN`, read at first use and cached 300
seconds, the pattern of `INVOKE_KEY_CACHE_SECONDS`), and nothing else. **Permissions:** `secretsmanager:GetSecretValue`
on that one secret; `sts:AssumeRole` and `sts:TagSession` on the two role ARNs. No DynamoDB, no S3, no SQS, no SSM.
**Environment:** `CHATTICUS_OWNER_SCOPED_ROLE_ARN`, `CHATTICUS_OWNER_SUPERVISOR_ROLE_ARN`,
`CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN`, `AWS_REGION`. The role ARNs, the duration (3600) and the tag keys are
fixed in code and environment; nothing in a request chooses them.

Payload (`ownerCredentialBrokerRequestSchema`, strict, `version: 1`):

| Field | Both purposes | `turn` only |
| --- | --- | --- |
| `version` | `1` | |
| `purpose` | `"supervisor"` or `"turn"` | |
| `tenant_id`, `computer_id`, `owner_id` | strings | |
| `generation` | integer > 0 | |
| `authorization` | the bootstrap token (`supervisor`) or the supervisor token (`turn`) | |
| `turn` | | `{ turn_id, bot_id, channel_id }` |

Response (`ownerCredentialBrokerResponseSchema`):

| Success | Fields |
| --- | --- |
| `ok: true, purpose: "supervisor"` | `aws_credentials`, `supervisor_token`, `supervisor_token_expires_at` |
| `ok: true, purpose: "turn"` | `aws_credentials`, `gateway_token`, `expires_at` |
| `ok: false` | `error: { code, message }`; `code` is one of `invalid_request`, `unsafe_tag_value`, `invalid_authorization`, `authorization_mismatch`, `assume_role_failed`, `signing_key_unavailable` |

What it does, in order:

1. Parse against the schema: `invalid_request` (a different `version`, an unknown field, a missing `turn`, a `turn` on a
   supervisor request, an unknown purpose).
2. Read the signing key: `signing_key_unavailable`.
3. **Verify the authorization itself** with the signing key: for `supervisor` the audience `owner-bootstrap`, for `turn`
   the audience `computer-owner`; signature, expiry. `invalid_authorization`. The claims' `tenantId`, `computerId`,
   `ownerId` and `startGeneration` must equal the payload's: `authorization_mismatch`. The broker therefore issues only
   for the owner a valid, unexpired token names, even if the Front Door passes the wrong tenant (a confused deputy).
4. Build the tags: `supervisorSessionTags({ tenantId, computerId })` for `supervisor`, `ownerSessionTags` with the five
   ids for `turn`. An unsafe id: `unsafe_tag_value`. Nothing is dropped or rewritten.
5. `AssumeRole` with the fixed role, `RoleSessionName` = `<purpose>-<ownerId>` cut to 64 characters, the tags,
   `DurationSeconds: 3600`, **no session policy**. Failure: `assume_role_failed` with only the AWS error name in
   `message`.
6. Sign: for `supervisor`, a `computer-owner` token with `issuedAtSeconds = now` and `expiresAtSeconds =
   min(now + 3600, floor(STS expiration))`; for `turn`, a `model-gateway` token with `startGeneration = generation` and
   the same expiry rule. `expires_at` and `aws_credentials.expires_at` are the STS expiration.

It refuses everything else. It does not read a store, so it cannot tell whether a turn is really parked; the **Front Door
decides that** and the broker bounds a Front Door fault to the owner a valid token names. It never logs a token, a key or
a credential; its log lines carry `purpose`, `tenant_id`, `owner_id`, `turn_id` (turn only) and the outcome or error code.
A Lambda error (a thrown exception, a timeout) reaches the Front Door as a function error and is mapped like `ok: false`.

The Front Door's port, in `conversation/src/computer/owner-credential-broker.ts` (A writes it, the Lambda adapter and the
fake):

```ts
import type { OwnerCredentialBrokerErrorCode, OwnerCredentialBrokerRequest, OwnerCredentialBrokerResponse } from "@chatticus/host-protocol/supervisor";

export type SupervisorGrant = Extract<OwnerCredentialBrokerResponse, { ok: true; purpose: "supervisor" }>;
export type TurnGrant = Extract<OwnerCredentialBrokerResponse, { ok: true; purpose: "turn" }>;

export class OwnerCredentialBrokerError extends Error {
	readonly code: OwnerCredentialBrokerErrorCode | "broker_unreachable" | "malformed_response";
	constructor(code: OwnerCredentialBrokerError["code"], message: string) {
		super(message);
		this.name = "OwnerCredentialBrokerError";
		this.code = code;
	}
}

export interface OwnerCredentialBrokerPort {
	issue(request: Extract<OwnerCredentialBrokerRequest, { purpose: "supervisor" }>): Promise<SupervisorGrant>;
	issue(request: Extract<OwnerCredentialBrokerRequest, { purpose: "turn" }>): Promise<TurnGrant>;
}
```

`issue` throws `OwnerCredentialBrokerError` for `ok: false`, an unreachable Lambda and a response that does not parse.
`LambdaOwnerCredentialBroker` is the production adapter (`CHATTICUS_OWNER_CREDENTIAL_BROKER_FUNCTION_NAME`);
`FakeOwnerCredentialBroker` in `conversation/features-support/fakes/` mints real tokens with the scenario key, returns
canned credentials, and records every request so a scenario can assert on tags and purposes. The Front Door composition
takes the port as a dependency exactly as it takes the clock and the stores.

## 8. Idle timeout, stop, drain

Owned by the supervisor, constants in section 3.

**Idle clock.** It starts when the supervisor first reaches `idle` and restarts when a child exits. Publishing does not
reset it. At `OWNER_IDLE_TIMEOUT_SECONDS` (900) of idleness the supervisor sends the stop request with `reason: idle`.
`owner_idle` is logged when the clock starts and every 300 seconds.

**Sequence on `idle`:**

1. Until the request is answered the supervisor still accepts a dispatch that arrives; if one does, the request is moot and
   the idle clock restarts when that child exits.
2. `POST /owner/stop-request`. A veto: log `owner_stop_vetoed reason=<reason>`, resume polling, do not ask again for 30
   seconds. A `work_pending` veto means a dispatch is about to arrive on the next poll.
3. Approved: report state `stopping` on the next poll; kill every uid-2000 process (none are expected: background
   processes are out of scope); publish if the index scan says the disk changed (no state change is written if it did
   not); `POST /computer/state` `{ stopped: true, start_generation: g }`; stop polling; exit 0. A failed stopped report
   is retried three times with 2 second spacing; a 403 `not_current_owner` on a retry means the first one landed (the
   stopped replay of 5.1 returns 200 first, so a 403 here is a different owner: exit 5).

**Drain.** When a poll answers `drain: true`: log `owner_draining reason=<reason>`, accept no dispatch, report `draining`.
If a child runs, wait for it up to 300 seconds; at the limit kill it (SIGTERM, 10 seconds, SIGKILL). Then send the stop
request with `reason: lifetime`, which is approved without regard to parked work, then run steps 3 of the idle sequence.
The parked turns are started by the stopped report.

**Unhealthy.** After three consecutive child exits with a code other than 0 and 1 (or a signal), the supervisor sends
`reason: unhealthy` and proceeds as for an approved stop. Exit code 1 is the legitimate loss of a claim race
(`ownerExitCodeFor`, `owner.ts:341-343`) and does not count.

**SIGTERM** (the task is being stopped; `owner-main.ts:89-96` today): stop accepting dispatches, kill the child (SIGTERM,
5 seconds, SIGKILL), kill uid-2000 stragglers, publish if changed, report stopped with the generation, exit 143, log
`owner_stopping reason=sigterm`. No stop request: the platform is stopping the task regardless, and the report lets the
control plane start the next owner at once. ECS gives the container 30 seconds by default; B sets `stopTimeout` to 90
seconds on the owner container.

**Maximum lifetime.** 3000 seconds from the bootstrap exchange, decided by the server (poll step 5). With the drain grace
and the final publish budget the owner is gone before its credentials expire (3000 + 300 + 120 = 3420 < 3600). The
supervisor additionally starts the final stop sequence 180 seconds before `aws_credentials.expires_at` if it is not
already stopping.

## 9. The container

### 9.1 Processes

| Process | User | Program | Holds |
| --- | --- | --- | --- |
| Init | root | ECS `initProcessEnabled: true` (B sets it on the owner task definition) | nothing; reaps zombies |
| Watchdog | root | `/usr/local/bin/chatticus-watchdog` (POSIX `sh`, shipped in the image) | nothing; started with an empty environment except `PATH` |
| Supervisor | root | `node /opt/chatticus/host/supervisor.mjs` (new bundle entry; no Pi) | bootstrap token until used, then supervisor token and credentials in memory |
| Child | root | `node /opt/chatticus/host/owner.mjs turn` (the existing owner bundle, one subcommand) | the dispatch's gateway token and AWS credentials |
| Shell commands | uid 2000 | `chatticus-shell` through the child (unchanged) | scrubbed environment (`local-computer-tools.ts` `scrubbedShellEnvironment`) |

The starter's command becomes `node /opt/chatticus/host/supervisor.mjs` (`OWNER_CONTAINER_COMMAND`,
`computer-host-start.ts:26`). `owner-main.ts`: the no-argument single-job mode and `startJobSourceFromEnvironment`
(`owner.ts:51-63`, `owner-main.ts:59-65`) are deleted, `shell-probe` and `file-probe` stay, `turn` is added; any other
argument exits 2. `runOwnerOnComputerDisk` (`owner.ts:279-332`) is deleted; its pieces (boot driver, publish, stopped
report) are the supervisor's. The supervisor reuses `ComputerHostBootDriver.bootThroughWorkspace` (`boot.ts:144`),
`hydrateOnBoot` and `publishBeforeExit` (`disk-lifecycle.ts:109,152`) with the supervisor client as the plane. It must
not import Pi, `computer-owner.ts`, `owner-deps.ts` stores or the starter (memory, and the bundle guard).

### 9.2 Supervisor environment and child environment

The ECS task environment (the overrides, plus the task definition's own `CHATTICUS_SNAPSHOT_BUCKET`, `CHATTICUS_LIVE_ROOT`,
`CHATTICUS_TENANT_ID` at `computer-stack.ts:91-95`) holds **names**:

`CHATTICUS_TENANT_ID`, `CHATTICUS_USER_ID`, `CHATTICUS_COMPUTER_ID`, `CHATTICUS_OWNER_ID`,
`CHATTICUS_OWNER_START_GENERATION`, `CHATTICUS_OWNER_BOOTSTRAP_TOKEN`, `CHATTICUS_FRONT_DOOR_URL`,
`CHATTICUS_MODEL_GATEWAY_URL`, `CHATTICUS_MESSAGING_TABLE`, `CHATTICUS_CONVERSATIONS_TABLE`,
`CHATTICUS_PI_SESSIONS_BUCKET`, `CHATTICUS_SNAPSHOT_BUCKET`, `CHATTICUS_ENVIRONMENT`, `AWS_REGION`, `AWS_DEFAULT_REGION`
(and `CHATTICUS_LIVE_ROOT` from the task definition). The only secret is `CHATTICUS_OWNER_BOOTSTRAP_TOKEN`. The supervisor
reads it once, deletes it from `process.env`, and never writes it anywhere.

The child is started with `child_process.spawn(process.execPath, [bundle/owner.mjs, "turn"], { env, stdio: ["ignore",
"inherit", "inherit"], cwd: "/workspace", detached: true })` where `env` is an object built from nothing:
`OWNER_CHILD_ENVIRONMENT_NAMES` and no other key.

| Variable | Value |
| --- | --- |
| `PATH`, `HOME` | the supervisor's |
| `CHATTICUS_TENANT_ID`, `CHATTICUS_OWNER_ID`, `CHATTICUS_OWNER_START_GENERATION` | the supervisor's |
| `CHATTICUS_USER_ID` | the dispatch's `user_id` (the member whose turn it is) |
| `CHATTICUS_DISPATCH_ID`, `CHATTICUS_TAKEOVER_TURN_ID`, `CHATTICUS_TAKEOVER_BOT_ID` | the dispatch |
| `CHATTICUS_MESSAGING_TABLE`, `CHATTICUS_CONVERSATIONS_TABLE`, `CHATTICUS_PI_SESSIONS_BUCKET`, `CHATTICUS_ENVIRONMENT` | the supervisor's |
| `CHATTICUS_MODEL_GATEWAY_URL` | the supervisor's |
| `CHATTICUS_MODEL_GATEWAY_TOKEN` | the dispatch's `gateway_token` |
| `CHATTICUS_WORKSPACE_ROOT`, `CHATTICUS_SHELL_LAUNCHER` | the supervisor's, if set |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | the supervisor's |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | the dispatch's per-turn credentials |

Never in the child: `OWNER_CHILD_FORBIDDEN_ENVIRONMENT_NAMES` (the bootstrap token, any supervisor token, the Front Door
URL, the snapshot bucket, the live root, the invoke key, the old host token, a model key). The supervisor's AWS credentials
are not in `process.env` at all (C5), so they cannot leak by inheritance. A unit test builds the child environment from a
supervisor environment that holds every forbidden name and asserts none appears and no unlisted key appears.
`ownerIdentityFromEnvironment` and `OwnerIdentityConfig` (`owner-deps.ts:104-130`) lose `frontDoorUrl` and `hostToken`
for the child (`:111,:128`).

**Credentials in 2a are passed once at fork.** The 2b local credential channel is the socket
`/run/chatticus/supervisor.sock` (mode 0600, root); it is reserved and nothing opens it in 2a.

### 9.3 Child exit codes and crash handling

| Child exit | Meaning | Supervisor action |
| --- | --- | --- |
| 0 | `done`, `failed`, `parked`, `yielded`, `already_finished` (`ownerExitCodeFor`, `owner.ts:341-343`) | clean |
| 1 | `lost`, `reconciling`, `not_found` | not a failure; logged |
| 2 | configuration error (`OwnerConfigurationError`, `owner-deps.ts:18`), unknown subcommand | counts toward the limit |
| 3 | shell launcher unusable (`ShellIsolationError`, `owner.ts:30`) | counts |
| 70, signal | uncaught exception, kill | counts |

Crash recovery needs nothing new. The supervisor reports state `idle` and polls at once; it does nothing for the turn.
The turn's lease (60 s, `domain/turns.ts:7`) runs out, the deadline probe finds an active, not-waiting turn with an expired
lease and recovers it into an ordinary run job for a Lambda (`probes.ts:176-205` and `handleUnownedTurn`
`probes.ts:135-163`: `recoverExpiredTurn`, `requestLogicalEnqueue`). The Lambda continues the Pi session; the interrupted
tool is reported lost and not re-run (`actions.ts` `expireLostComputerActions`: an idempotent action is released, a
non-idempotent one answered "interrupted", `actions.ts:309-333`), and the next computer tool parks again, finds the live
owner (`liveOwnerOf`) and is dispatched. One recovery per turn (`DEFAULT_MAXIMUM_RECOVERY_ATTEMPTS`, `probes.ts:21`); a
second vanished owner fails the turn. The poll also settles lost actions (poll step 4), so an interrupted action is
answered without waiting for a probe.

If the supervisor or the task dies, heartbeats stop; after 30 seconds `liveOwnerOf` is false; the next parked turn's start
job proceeds (6.5) and a new owner hydrates the last snapshot; if the disk was dirty the record is settled lost
(`computers.ts:190-208`).

### 9.4 Logs

Standard output and error of the container go to the `awslogs` driver, stream prefix `computer-owner`
(`computer-stack.ts:131-134`). The child inherits both, so its lines (which carry `tenant_id`, `turn_id`, `owner_id`) and
the supervisor's interleave, one line per event. The emitter is `consoleLogEmitter` (`log-line.ts`); the supervisor's scope
is `tenant_id`, `owner_id`. **No line carries a token, a key, a credential, a tool argument or a tool output.**

New and changed lines (fields in addition to the scope):

| Line | Fields |
| --- | --- |
| `owner_started` (existing, `owner.ts:253`) | `generation`, `pid` |
| `owner_bootstrapped` | `expires_at` |
| `owner_bootstrap_failed` | `status`, `code` or `error_name`, `attempts` |
| `owner_polling` (once a minute) | `polls`, `interval_ms`, `dispatches`, `failures` |
| `owner_poll_failed` | `status` or `error_name`, `consecutive_failures`, `silent_seconds` |
| `owner_idle` | `idle_seconds`, `timeout_seconds` |
| `owner_dispatch_received` | `dispatch_id`, `turn_id`, `bot_id`, `attempt` |
| `owner_serving_turn` | `dispatch_id`, `turn_id`, `bot_id`, `queue_wait_ms`, `concurrent` (always 1) |
| `owner_child_exited` | `dispatch_id`, `turn_id`, `code`, `signal`, `duration_ms`, `clean` |
| `owner_draining` | `reason` |
| `owner_stop_requested` | `reason` |
| `owner_stop_vetoed` | `reason` |
| `owner_stopping` | `reason` (`idle`, `lifetime`, `unhealthy`, `sigterm`, `fenced`, `superseded`), `uptime_ms`, `turns_served` |
| `snapshot_published`, `snapshot_skipped` (existing) | existing |
| `owner_exit` (existing, `owner.ts:256`) | `code`, `outcome`, `duration_ms` |
| `owner_watchdog_fired` (watchdog, `sh` echo) | `action` (`term`, `kill`), `reason` (`deadline`, `stale`) |

Front Door lines (no token): `owner_bootstrap_ok`, `owner_bootstrap_refused code=<code>` (a `bootstrap_already_used` is
an anomaly worth an alarm), `owner_dispatch_offered` (`dispatch_id`, `turn_id`, `attempt`, `reoffer`),
`owner_dispatch_failed code=<code>`, `owner_dispatch_skipped reason=<reason>`, `owner_stop_decision` (`reason`,
`approved`, `veto`), `owner_memory_high`. Starter: `computer_start_already_serving`, and the existing start lines minus
the STS ones.

### 9.5 Supervisor process rules

- **Poll loop.** Starts as soon as the bootstrap exchange succeeded, concurrently with hydration. One request in flight.
  Request timeout 10 seconds. On failure repeat the same `sequence` with a pause of 1, 2, 4, then 5 seconds. On success
  increment `sequence`. A 403 `stale_generation`, `not_current_owner`, `wrong_organization` or `credential_mismatch`, and
  a 401, are fatal: kill the child, publish nothing, exit 5, `owner_stopping reason=superseded`. A 409 `stale_poll`
  cannot happen to a supervisor that keeps one request in flight; if it does, log it and continue with `sequence + 1`.
  Any other status or a network error is a failure to retry. Every request carries `X-Chatticus-Host-User-Id` set to
  `CHATTICUS_USER_ID` (the capability reports need it, `host.ts:115`).
- **Fence.** `OWNER_POLL_SILENCE_FENCE_SECONDS` (25) without a successful poll: kill the child with SIGKILL, publish
  nothing, exit 4, `owner_stopping reason=fenced`. Not applied during the bootstrap retry window (there is no live owner
  yet).
- **Bootstrap.** Up to 120 seconds of retry (2 second pause) on network failure, 5xx and 503 `credentials_unavailable`;
  any other status is fatal. Exit 6.
- **Boot failure.** If hydration throws, log `snapshot_skipped reason=boot_failed`, publish nothing, report nothing,
  exit 8 (`owner.ts:315-318` behavior). The heartbeat lapses and the control plane settles the computer.
- **After a dispatch arrives.** Dedupe by `dispatch_id` and by `turn_id`: a dispatch for a turn already served or being
  served is ignored. If a publish is running, report `publishing` (the server offers nothing then), so a dispatch arrives
  only in `idle`. Fork the child, report `serving` with `active_turns` on the next poll, which is immediate.
- **Child exit.** Kill all uid-2000 processes (C16; read `/proc/*/status`, no package that the image lacks), log
  `owner_child_exited`, restart the idle clock, poll at once, schedule the quiet publish 30 seconds out.
- **Publish.** In state `publishing`, only if no child runs and the index scan (`hostDiskNeedsPublish`,
  `disk-lifecycle.ts:75-80`) says the disk changed; otherwise `snapshot_skipped reason=unchanged` and no state change.
  Quiet: 30 seconds after a child exits. Periodic: every 600 seconds of idleness. Final: in the stop sequence. A publish
  failure is logged (`snapshot_publish_failed`) and retried at the next trigger; on the final publish it is logged and the
  stop proceeds (the unpublished work is lost, as a crash would lose it).
- **Liveness file.** A timer touches `/run/chatticus/supervisor.alive` every 15 seconds for as long as the event loop turns.

### 9.6 The watchdog

A separate process, spawned detached by the supervisor as its first action, before the bootstrap exchange, with an empty
environment except `PATH`, written as a POSIX `sh` script so that it shares nothing with the Node event loop. It knows the supervisor's
PID and its own start time and loops every `OWNER_WATCHDOG_CHECK_SECONDS` (15):

1. The supervisor is gone (`kill -0` fails): exit 0.
2. `OWNER_WATCHDOG_TERMINATE_SECONDS` (3300) since it started: `kill -TERM` the supervisor once, log
   `owner_watchdog_fired action=term reason=deadline`.
3. `OWNER_WATCHDOG_KILL_SECONDS` (3420) since it started: `kill -KILL`, log `action=kill reason=deadline`.
4. `/run/chatticus/supervisor.alive` older than `OWNER_WATCHDOG_STALE_SECONDS` (180): `kill -KILL`, log
   `action=kill reason=stale`. This is the case the timer cannot see: a wedged or blocked main loop.

A killed supervisor ends the essential container, so the task stops. SIGKILL loses unpublished writes; that is the price of
a guarantee that no bug in the idle timer or the poll loop becomes an idle floor. The directory `/run/chatticus` is root,
mode 0700. uid 2000 cannot signal a root process. The watchdog holds no credential and calls no API.

## 10. State machines

### 10.1 Owner

| State | Reported as | Entered by | Left by |
| --- | --- | --- | --- |
| booting | `booting` | process start; reported once the bootstrap exchange succeeded | boot driver begins |
| hydrating | `hydrating` | `setComputerStopped(false)` through workspace gate (`boot.ts:144-153`) | hydration done (`idle`) or failed (exit 8) |
| idle | `idle` | hydrated; a child exited; a publish ended | dispatch received (`serving`); publish due (`publishing`); idle timeout (stop request); drain |
| publishing | `publishing` | quiet, periodic publish due | publish ends (`idle`) |
| serving | `serving` | child forked after a dispatch | child exits (`idle`); drain |
| draining | `draining` | poll answered `drain: true` | child done or grace over, then `lifetime` stop request |
| stopping | `stopping` | stop approved; SIGTERM handled | stopped report sent, exit |
| stopped | not reported | exit | |

Fatal exits from any state: 4 fenced, 5 superseded, 6 bootstrap failed, 7 configuration, 8 boot failed, 143 SIGTERM, 137
watchdog kill (signal).

### 10.2 Dispatch

`offered` to `claimed` (child's `takeOverTurn`), `claimed` to `finished` (child exit seen as `idle`), `offered` to
`expired` (30 s lapse, re-offered with `attempt + 1`), `offered` to `void` (turn answered or failed). A poll with the same
`sequence` re-offers an `offered` dispatch unchanged. Table in 6.3.

### 10.3 What one turn looks like

Turn parks (`parkOnComputerAction`, `park.ts:209-242`): action `requested`, `liveOwnerOf` true so no start job. Next poll in
`idle`: dispatch offered (broker call). Supervisor forks the child. Child: `takeOverTurn` clears waiting, claims, runs the
tool locally, answers the action, ends the turn. Child exits 0. Supervisor `idle`, polls at once, quiet publish in 30 seconds.

## 11. Starter and infrastructure

### 11.1 Starter (code in `conversation/`, owner A; environment and IAM in CDK, owner B)

`OwnerStartDriver.start` (`owner-start-driver.ts:132-224`) becomes: generate `ownerId`; validate `tenantId` and
`computerId` with `supervisorSessionTags`; sign the bootstrap token (`owner-bootstrap`, `startGeneration =
claim.hostStartGeneration`, `issuedAtSeconds = now`, `expiresAtSeconds = now + 300`); register the owner worker
(`registerOwnerWorker`, unchanged); `RunTask`. It no longer reads the turn (`getTurn` is removed from `OwnerStartPorts`,
and with it the `turn_not_found` refusal at `:134-138`), no longer mints a gateway or host token, and no longer calls STS
(`assumeRole` is removed from `OwnerStartPorts`; `OwnerStartConfig.scopedRoleArn` is removed). The job's `turnId` and
`botId` remain in `ComputerStartJob` for logs.

Container override environment: section 9.2, names as listed. **Removed from today's list
(`owner-start-driver.ts:188-209`):** `CHATTICUS_TAKEOVER_TURN_ID`, `CHATTICUS_TAKEOVER_BOT_ID`,
`CHATTICUS_MODEL_GATEWAY_TOKEN`, `CHATTICUS_OWNER_HOST_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN`. **Added:** `CHATTICUS_COMPUTER_ID`, `CHATTICUS_OWNER_BOOTSTRAP_TOKEN`. Command:
`node /opt/chatticus/host/supervisor.mjs`.

Starter IAM (`computer-host-start.ts:409-487`, `control-plane-stack.ts:308-377`): keeps `ecs:RunTask` on the owner task
definition family, `iam:PassRole` for the owner task and execution roles, `secretsmanager:GetSecretValue` on the signing
key, the Messaging table, the SQS sends. **Loses** `sts:AssumeRole` and `sts:TagSession` on the scoped role
(`computer-host-start.ts:482`). It never invokes the broker. The customer-account `sts:AssumeRole` on
`ChatticusOrganizationComputerRole` stays (`control-plane-stack.ts:330-335`).

### 11.2 ControlPlane stack (owner B)

- `OwnerCredentialBroker` Lambda (section 7) and its execution role.
- `ComputerSupervisorRole`; trust principal the broker role with the two-tag conditions; `maxSessionDuration` 3600;
  permissions from `supervisor-role-policy.json` via a new `supervisorRolePolicyStatements` next to
  `ownerRolePolicyStatements` (`infra/lib/owner-role-policy.ts`).
- `ComputerOwnerScopedRole` trust principal changes from the starter role to the broker role
  (`computer-host-start.ts:417-419`); the `TagSession` statement follows (`:423-429`); `ownerRolePolicyStatements` loses the
  snapshot placeholder.
- Front Door: `lambda:InvokeFunction` on the broker; env `CHATTICUS_OWNER_CREDENTIAL_BROKER_FUNCTION_NAME`; it already has
  the signing key (`control-plane-stack.ts:393-400`).
- Starter: environment loses `CHATTICUS_OWNER_SCOPED_ROLE_ARN`, keeps the rest.
- Outputs: the broker ARN.

### 11.3 Computers stack (owner B)

Delete the legacy own-account host (`computer-stack.ts`): `ComputerTaskRole` and its snapshot grant (`:70-74`), the
`ComputerTask` task definition and container (`:81-107`), the `FargateHost` service (`:144-155`), the `computerCount`
context (`:43`), and the outputs `ComputerTaskDefinitionArn` and `ComputerServiceName` (`:163-168`), plus
`infra/README.md` lines 73-74 and 275. **Keep** the VPC, ECR repository, cluster, the owner task definition and its empty
task role (`:109-136`), and `ComputerSecurityGroup` (`:138-142`). **Add:** outputs `ComputerSubnetIds`
(comma-separated) and `ComputerSecurityGroupId`, because `lookupComputersHostStart` reads the subnets and security group
from the Fargate service (`computer-host-start.ts:150-190`) and must read the stack outputs instead. On the owner task
definition: `linuxParameters.initProcessEnabled = true` and container `stopTimeout` 90 seconds.
`wireComputerStarterEcsRunTask` (`computer-host-start.ts:243-312`) loses `CHATTICUS_ECS_TASK_DEFINITION`,
`CHATTICUS_ECS_HOST_COMMAND`, and the RunTask and PassRole statements for the legacy task definition; it keeps
`CHATTICUS_HOST_STARTER=ecs`, the cluster, subnets, security groups, container name, the deployment account id and the
customer-account `sts:AssumeRole`. The customer-account stack (`customer-computers-stack.ts`, `infra/assets/`) is a
different stack and is not touched; its own `FargateHost` is the customer host worker's.

CDK tests that change: `infra/test/computer-owner-stack.test.ts` (lines 90, 136, 148, 343 name the legacy role, policies,
output and variable), `infra/test/computer-image-publish.test.ts` stays.

### 11.4 Image (owner C)

`computer/host/esbuild.config.mjs` adds the entry `supervisor`. `computer/Dockerfile` copies `computer/chatticus-watchdog`
to `/usr/local/bin` and `chmod 755`s it, beside `chatticus-shell`. The entrypoint is unchanged (`exec "$@"`,
`entrypoint.sh`). `computer/test_owner_container.sh:47` greps `owner_no_job`, which no longer exists; it must exercise the
new modes. `conversation/test/computer-image-structure.test.ts` gains the `supervisor` entry in its bundle check and a check
that nothing the supervisor bundles matches `owner-start-driver` or the starter files.

## 12. Security

### 12.1 Credentials

| Credential | Who holds it | What a thief can do | Bound by | Refusal rules |
| --- | --- | --- | --- | --- |
| Bootstrap token | the ECS task description (readable with `ecs:DescribeTasks` for about an hour), then nobody | exchange it once, within 5 minutes, before the real owner: become the owner for at most an hour | audience, tenant, computer, owner, generation, 300 s, once | replay: 409 `bootstrap_already_used`; expired or tampered: 401; other tenant: 403 `wrong_organization`; generation moved on: 403 `stale_generation`; presented to any other route: 401 (audience) |
| Supervisor token | supervisor memory | call the owner routes of one computer while it is the live generation: poll (and receive per-turn grants for parked turns, one at a time), stop-request, state, hydrate and publish records | audience, tenant, computer, owner, generation; 3600 s | stale generation 403; stopped or replaced owner 403 `not_current_owner`; other tenant 403; expired 401; gateway or bootstrap token 401. Not accepted on `/actions/*`, `/heartbeat`, the gateway, user routes, operator routes, worker registration. |
| Supervisor AWS credentials | supervisor memory | read and write `tenants/T/computers/K/*` objects of one computer; nothing in DynamoDB, the Pi sessions bucket, Secrets Manager or STS | role statement above; 3600 s | cannot be minted without a bootstrap token the broker verifies |
| Per-turn gateway token | the child's environment | model calls for one turn while this owner holds its claim | tenant, bot, turn, owner; 3600 s | unchanged (`model-gateway.ts:260-268`) |
| Per-turn AWS credentials | the child's environment | one conversation: Pi session objects and items of `T/B/C`, the key families of `owner-role-policy.json` (finding 4), not the snapshot (C4) | five session tags, static policy, 3600 s | unchanged except the snapshot statement |
| Broker invoke | the Front Door role | issue credentials for the owner a valid token names | Lambda resource policy to one role, authorization re-verified | `authorization_mismatch`, `invalid_authorization`, `unsafe_tag_value` |
| Signing key | Front Door, starter, broker | mint any token | unchanged secret; the broker adds one reader | |

### 12.2 Findings, status

- **Finding 1 (symlink escape):** unchanged and holds. The child uses the same helper through the launcher; nothing in
  the supervisor opens a path the model named.
- **Finding 2 (invoke key in the owner):** holds. The supervisor holds a signed token, never the invoke key; the task
  environment has no `CHATTICUS_INVOKE_KEY` (it is on the forbidden list).
- **Finding 3 (secrets in RunTask overrides):** closed for AWS keys and tokens. The overrides hold one bootstrap token,
  five minutes, once. A reader of `DescribeTasks` can race the owner for it; the loser learns of it (`owner_bootstrap_refused
  code=bootstrap_already_used`, owner exit 6). That is accepted: the reader needs `ecs:DescribeTasks`, an operator
  permission, and the window is the seconds between task start and the first exchange.
- **Finding 4 (tenant-wide table reach):** holds and improves. The five-tag per-turn role is unchanged except that it
  loses the snapshot statement; the new role has no table access at all, so a stolen supervisor credential cannot read or
  write Messaging or Conversations or other prefixes. Scenarios (`owner_role_policy.feature`) assert both: the supervisor
  role allows only `GetObject`, `PutObject`, `AbortMultipartUpload` on its own computer's prefix, and denies every
  DynamoDB action, every other tenant's prefix, another computer's prefix, `DeleteObject`, `ListBucket` and the Pi sessions
  bucket.
- **Finding 5 (gateway ceiling), 6 (invoke key in CloudFront):** unchanged.
- **Finding 7 (restore):** unchanged.
- **Finding 8 (worker tokens):** the owner's worker token is never handed out; accumulation of worker items unchanged.

### 12.3 New exposure, honestly

- **The broker widens the Front Door.** The Front Door already reads and writes Messaging; through the broker it can now
  obtain write credentials for any conversation and snapshot prefix. The broker bounds a bug (it needs a valid token naming
  the owner) but not a full Front Door compromise, which already holds the signing key. The alternative (broker reads the
  turn table) would add a data store to a function that is meant to have none. Recommended as built.
- **A supervisor token is the owner for up to an hour.** It receives per-turn grants for parked turns. It cannot ask for a
  grant for an arbitrary conversation: only the Front Door's parked-work query chooses one. Stopping the computer, or
  claiming a new generation, kills it at once (steps 5 and 6 of 5.1).
- **The supervisor is root and long-lived.** It holds the snapshot credentials. The shell (uid 2000) cannot read its
  memory or environment (`/proc/<pid>/environ` is unreadable across uids; `computer/test_owner_container.sh` proves it for
  the owner today and must prove it for the supervisor). The metadata credentials endpoint remains reachable and the task
  role remains empty (design limit, unchanged).
- **A returned zombie owner** can no longer publish over a newer owner's snapshot: the snapshot routes check the live
  generation (5.1 step 6).

## 13. Traceability

Scenario names are those of `features/computer_owner_long_lived.feature`. Tags: `@server` (A), `@broker` (B),
`@supervisor` (C), `@end-to-end` (the integration, written last).

| Scenario | Routes, states and sections | Tag |
| --- | --- | --- |
| A second turn is served by the live owner without a start | park, `liveOwnerOf` (6.2), poll `idle`, dispatch, `claimed`, `owner_started` once | end-to-end |
| A turn parked behind a busy owner waits and then runs | poll `serving` gets no dispatch; poll `idle` after the child exits gets it (D5) | end-to-end |
| A start job that arrives while the owner drains is acknowledged and the stopped report starts the next owner | 6.5, poll drain, stop `lifetime`, `POST /computer/state` stopped, `startOwnerForParkedTurns` | end-to-end |
| A child that crashes mid-turn leaves the turn to the lost-owner recovery | 9.3, `probes.ts:176-205`, `expireLostComputerActions` | end-to-end |
| The owner exchanges its bootstrap token once | bootstrap 200 then 409 `bootstrap_already_used`; 5.2 | server |
| A bootstrap token that is not good is refused | bootstrap 401, 403 (`wrong_organization`, `stale_generation`, `credential_mismatch`) | server |
| A bootstrap that the broker cannot serve does not burn the token | bootstrap 503, mint-then-consume (5.2 steps 7, 8) | server |
| The poll is the heartbeat | poll step 2, `liveOwnerOf`, 30 s window | server |
| A poll whose answer was lost is answered with the same dispatch | 6.3 rule 1, dispatch `offered` | server |
| A dispatch that was never claimed is offered again under a new id | 6.3 `expired`, `attempt` | server |
| A claimed dispatch is not offered again | 6.3 `claimed` (`takeOverTurn`) | server |
| Only one dispatch is outstanding and none is offered while the owner serves | poll `serving`, D5 | server |
| A dispatch carries the credentials of one conversation and no host token | `ownerDispatchSchema`, broker `turn`, C3 | server |
| A parked action of an organization over its spend ceiling is denied and not delivered | 6.3 rule 2 | server |
| The control plane tells the owner how soon to ask again | 6.4 | server |
| A poll that arrives out of order is refused | poll step 2, 409 `stale_poll` | server |
| An owner of an older generation is refused on every owner route | 5.1 step 5 | server |
| A token that does not belong to this owner, organization or moment is refused | 5.1 steps 2, 3, 4, 6 | server |
| The supervisor token is refused on every route the supervisor does not call | route allow-list (section 5), C19 | server |
| The owner routes cannot be opened with the invoke key alone | 5.1 step 1 | server |
| A stop is vetoed by pending work | stop request `idle`, 5.4 predicate | server |
| A stop with nothing pending is approved and the computer stops accepting dispatches | 5.4 approval write, 6.5 | server |
| A parked action of a finished turn does not veto a stop | 5.4 `parkedWork` definition | server |
| An approved stop and a dispatch cannot both win | 5.4 and 6.3 step 5 conditional updates | server |
| A stop for the lifetime is refused before the owner is told to drain and approved after | stop `lifetime`, `not_draining` | server |
| The control plane drains an owner at its maximum lifetime | poll step 5, C6 | server |
| An owner that is failing is allowed to stop whatever is pending | stop `unhealthy` | server |
| A stale start job is acknowledged as already serving | 6.5, `already_serving` | server |
| An owner that is still hydrating counts as the owner | 6.2, C18 | server |
| An owner whose heartbeat lapsed no longer counts and the start goes ahead | 6.2 then `requestComputerHostStart` | server |
| A customer-account host worker is unaffected by the owner check | `liveOwnerOf` false without `ownerId` | server |
| The stopped report ends the owner and can be repeated | 6.6, 5.1 step 6 stopped replay | server |
| An owner that was replaced cannot publish over the newer owner's snapshot | 5.1 step 5, `POST /snapshot/published` | server |
| The starter holds no role and puts one secret in the task | 11.1, C1, C2 | server |
| An identifier that cannot be a session tag value stops the start before a task runs | 4.1 `supervisorSessionTags` | server |
| The broker issues supervisor credentials for the owner a bootstrap token names | 7 steps 3 to 6, `ComputerSupervisorRole` | broker |
| The broker issues turn credentials with the five tags and a gateway token | 7, `ComputerOwnerScopedRole` | broker |
| The broker refuses what it should not issue | 7 steps 1, 3, 4 | broker |
| The broker reports an STS failure by name only | 7 step 5 | broker |
| The broker cannot sign without its key | 7 step 2 | broker |
| The supervisor role reaches its computer's snapshot prefix and nothing else | 4.1 policy file, finding 4 | broker |
| A per-turn credential reaches its own conversation and not the snapshot or another channel | 4.1, C4, finding 4 | broker |
| An owner with a bootstrap token and a snapshot hydrates, becomes idle and holds nothing in its environment | 9.2, 9.5, states `booting`, `hydrating`, `idle`, C5 | supervisor |
| A bootstrap the control plane refuses ends the owner | 9.5 bootstrap, exit 6 | supervisor |
| A bootstrap that cannot reach the control plane is retried inside the token's life | 9.5 bootstrap | supervisor |
| A dispatch starts a child that holds the turn's credentials and nothing of the supervisor's | 9.2, `OWNER_CHILD_ENVIRONMENT_NAMES` | supervisor |
| A dispatch for a turn the supervisor already serves is ignored | 9.5 after a dispatch arrives | supervisor |
| A child that exits cleanly returns the supervisor to idle at once | 9.3, 9.5 child exit | supervisor |
| A child that lost the claim race is not a failure | 9.3 exit code 1 | supervisor |
| Three children in a row that fail make the owner stop as unhealthy | 8 unhealthy | supervisor |
| A process the model left running does not survive its turn | C16 | supervisor |
| Idle timeout publishes and stops | 8 idle sequence, states `idle`, `stopping` | supervisor |
| A stop that is vetoed is not asked for again for thirty seconds | 8 step 2, `OWNER_STOP_RETRY_SECONDS` | supervisor |
| A dispatch that arrives with the veto is served and the idle clock starts over | 8 step 1 | supervisor |
| An owner told to drain finishes its turn and stops | 8 drain, state `draining` | supervisor |
| A drain gives the turn five minutes and then ends it | 8 drain, C9 | supervisor |
| Quiet publish runs between turns and only when the disk changed | 9.5 publish, C14, state `publishing` | supervisor |
| A publish never runs while a child runs | C14 | supervisor |
| An owner that cannot reach the control plane fences itself before the control plane counts it dead | 9.5 fence, C17, exit 4 | supervisor |
| An owner that is told it is no longer the owner stops without publishing | 9.5 poll loop, exit 5 | supervisor |
| A poll that fails is repeated with the same sequence number | 9.5 poll loop, 5.3 step 2 | supervisor |
| SIGTERM stops the child, publishes and reports stopped | 8 SIGTERM, exit 143 | supervisor |
| The supervisor logs carry no token, key or credential | 9.4 | supervisor |
| The watchdog ends a supervisor whose main loop stopped | 9.6 rule 4 | supervisor |
| The watchdog asks, then forces, at the end of the lifetime | 9.6 rules 2, 3 | supervisor |

Scenarios of the design document's Phase 2 list that are 2b and therefore not drafted: credential refresh extends credentials and is
refused for a stale generation or a stopped computer; an owner below the minimum protocol version drains.

**Live proof (development).**

1. Send a message that needs the computer. In the log: `owner_started`, `owner_bootstrapped`, `workspace_hydrated`,
   `owner_dispatch_received`, `owner_serving_turn`, `owner_child_exited clean=true`, `snapshot_published`.
   `aws ecs describe-tasks` shows `CHATTICUS_OWNER_BOOTSTRAP_TOKEN` and no `AWS_*` name.
2. Replay that bootstrap value against `POST /host/owner/bootstrap` (it is in the task description): 409.
3. A second message five minutes later: its first computer action is claimed within 15 seconds (8 if sent within 5
   minutes), no `owner_started` between the two.
4. Leave the computer alone for 15 minutes: `owner_stop_requested reason=idle`, `owner_stopping reason=idle`,
   `snapshot_published` (if changed), the task STOPPED, the computer record stopped with no `ownerId`.
5. Stop the task mid-turn (`ecs stop-task`): `owner_stopping reason=sigterm`; recovery by a Lambda; the next computer call
   starts one new owner.
6. Kill only the child (`kill -9` through a debug command on a development task): `owner_child_exited clean=false`,
   the turn recovered, the owner still polling.
7. CloudTrail: `AssumeRole` of `ComputerSupervisorRole` with tags `tenant`, `computer`, and of `ComputerOwnerScopedRole` with
   the five, both by the broker role, none by the starter role.
8. Optional, 55 minutes of activity: `owner_draining reason=lifetime`, `owner_stopping reason=lifetime`.

## 14. Assumptions and open questions

**Assumptions** (marked where they appear): the on-demand prices (C13); a missing snapshot key without `ListBucket`
(4.1); `initProcessEnabled` delivers SIGTERM to the supervisor through the entrypoint's `exec` (11.3); `/proc/*/status`
is readable to root for the uid sweep; the 512 MiB task holds the supervisor alone while publishing (the supervisor
bundle excludes Pi); Hono matches `/owner/poll` without clashing with `/actions/:action_id/*`; `z.iso.datetime()` accepts
the output of `Date.toISOString()` (tested).

**Open questions for the owner**

- **Q1. Fence at 25 seconds of poll silence, losing unpublished work.** The recommendation is as built (C17): two writers
  on one disk is worse than losing up to 10 minutes of a rare outage's writes. The alternative is to keep serving until
  the control plane actually starts a second owner, which the owner cannot see.
- **Q2. External watchdog in 2b, not 2a.** The recommendation is as built (C10). The alternative is to build the
  `OwnerLifetimeCheck` chain and `ecs:StopTask` now; it adds a permission and a message type for a 50 minute cap.
- **Q3. Killing uid-2000 processes at the end of every turn (C16).** A person who asks the bot to "start a server and leave
  it running" will see it die at turn end until Phase 4. The recommendation is to keep it killed: it is the honest behavior
  of one-turn-at-a-time with no process table.

## 15. Work assignment

Three people. Each reads sections 2, 3 and the one for their part. Everything is a PR into `develop` with Gherkin first
(`AGENTS.md`); the contract PR that adds this page, the schemas and the draft feature merges first. Steps for the draft
scenarios are written by whoever owns the tag; a scenario enters `features/cucumber-features.txt` together with its steps.
Do not read or write `project/`.

### A. Server (conversation/)

- [ ] **A0 (first, small, merged before B and C start integrating):** `gateway/session-token.ts` (audiences, claims union,
  `verifySessionToken` by audience, `owner-host` deleted); `gateway/session-tags.ts` (`supervisorSessionTags`);
  `gateway/supervisor-role-policy.json`; `gateway/owner-role-policy.json` minus `ComputerSnapshotObjects`;
  `computer/owner-credential-broker.ts` (port, error, `LambdaOwnerCredentialBroker`);
  `features-support/fakes/` `FakeOwnerCredentialBroker`; move `OWNER_CREDENTIAL_LIFETIME_SECONDS` to the shared constants.
- [ ] Store: `store/codecs/computer.ts`, `store/codecs/worker.ts`, `store/messaging-store.ts`, `store/dynamo-messaging-store.ts`
  (conditional updates: bootstrap consume, offer, approve stop, idle transitions; `claimHostStartGeneration`,
  `settleLostComputerHost` clear owner fields) and the in-memory store used by scenarios; contract test in
  `test/dynamo-messaging-store.contract.test.ts`.
- [ ] Domain: `domain/computers.ts` (`liveOwnerOf`, `setComputerStopped` clears), `domain/owner-supervisor.ts` (new: poll
  decision, dispatch lifecycle, stop predicate), `domain/computer-start.ts` (`already_serving`), `domain/workers.ts`,
  `turn/park.ts` (extract `parkedWork`, `ensureHostForParkedTurn` consults `liveOwnerOf`).
- [ ] HTTP: `http/owner-host-auth.ts` (5.1), `http/owner-supervisor.ts` (new handlers), `http/host.ts` (supervisor principal
  on the four routes, heartbeat stays worker-only, stopped replay), `http/app.ts` (declare routes, `route-audience.ts`
  audiences), 422 bodies with `code`.
- [ ] Starter code: `computer/owner-start-driver.ts` (11.1), `lambdas/computer-starter.ts` composition (no STS port).
- [ ] Steps and features that change: `owner_host_token.feature` and `owner-host-token.steps.ts` (rewritten for the
  supervisor token), `computer_owner_start.feature`, `owner_start_observability.feature`,
  `computer_owner_policy_coverage.feature` (the supervisor and the child are recorded separately and evaluated against
  their own policy files), `owner_role_policy.feature` (extend for the supervisor role, drop the snapshot rows from the
  per-turn role), `computer_owner_single_writer.feature` (stays for host workers), `test/route-audience.test.ts`. Add
  `@server` scenarios of the draft feature and their steps.

### B. Infrastructure and broker (infra/, one Lambda in conversation/)

- [ ] `conversation/src/lambdas/owner-credential-broker.ts` and its unit test (section 7), with the `@broker` scenarios.
- [ ] `infra/lib/control-plane-stack.ts`, `infra/lib/computer-host-start.ts`, `infra/lib/owner-role-policy.ts`:
  broker Lambda and role; `ComputerSupervisorRole`; trust of both roles on the broker; Front Door invoke permission and
  environment; starter environment and IAM (11.1, 11.2).
- [ ] `infra/lib/computer-stack.ts` and `infra/README.md`: remove the legacy host, add the outputs, `initProcessEnabled`,
  `stopTimeout` (11.3). `lookupComputersHostStart` reads the outputs.
- [ ] `infra/test/computer-owner-stack.test.ts`: assertions for the broker's permissions (nothing but the secret and the
  two roles), the roles' trust and tag conditions, the starter's missing STS right, the Front Door invoke right, the
  legacy resources gone, the owner command.

### C. Container (computer/)

- [ ] `computer/host/src/supervisor-main.ts` and modules: bootstrap, poll loop with retry and fence, state machine,
  hydrate and publish cadence, idle clock, stop and drain sequences, SIGTERM, child spawn and environment builder,
  uid-2000 sweep, liveness file, logs (sections 8 and 9). Reuse `boot.ts`, `disk-lifecycle.ts`.
- [ ] `computer/host/src/protocol-client.ts` (bootstrap, poll, stopRequest with the schemas; supervisor token; header
  rules), `owner-main.ts` (child: `turn`, `shell-probe`, `file-probe`; delete the single-job mode), `owner.ts` (delete
  `runOwnerOnComputerDisk` and the job source), `owner-deps.ts` (child identity without the Front Door and host token).
- [ ] `computer/chatticus-watchdog`, `computer/Dockerfile`, `computer/host/esbuild.config.mjs`,
  `computer/test_owner_container.sh`, `conversation/test/computer-image-structure.test.ts`.
- [ ] `@supervisor` scenarios with a fake Front Door plane, a fake clock and a fake spawner (step files
  `owner-supervisor-process.steps.ts` and a fake in `features-support/fakes/`); a vitest unit test of the child
  environment builder.

### Order and dependencies

1. This contract merges.
2. A0 merges. After it: A, B and C work in parallel.
3. C needs only the schemas (this PR) and a fake plane. B needs A0 (tokens, tags, policy file). A's routes need the
   broker only through the port, with the fake.
4. The `@end-to-end` scenarios are written by C after A's routes land, in one shared steps file.
5. The `@broker` scenarios and the CDK tests run without AWS.

### Deploy order (development only; no compatibility path exists)

Merging to `develop` deploys the ThinTurn stack and builds the image from CI; the Computers stack is manual. Computer
turns on development fail in the window between steps, which is minutes; nobody else uses it. Wait until no owner task is
running (`aws ecs list-tasks`) because an old-style owner loses its token audience.

1. `cdk deploy ChatticusComputers` (B): adds the outputs and the new owner task definition revision, removes the legacy
   host. The deployed ThinTurn keeps running with the old environment; the legacy service had a desired count of 0.
2. Immediately after, the merge of A, B and C together to `develop`. Order inside it does not matter because the image
   (CI) and the stack (CI) land within minutes of each other; a computer turn that starts between them fails at the start
   and is retried by the queue. Do not run `cdk synth` of ThinTurn between steps 1 and 2: it reads the Computers outputs.
3. Verify with the live proof (section 13).

What breaks in between, and only on development: a start by the old starter runs `supervisor.mjs` that the old image lacks;
a start by the new starter runs the old image; an owner mid-turn at the moment of the ThinTurn deploy loses `/heartbeat`
and `/computer/state` (the audience is gone) and is settled lost by heartbeat. Hence the idle check first.

## 16. What changes in existing tests and files

`owner_host_token.feature` and its steps (new audience), `computer_owner_start.feature`, `owner_start_observability.feature`,
`computer_owner_entry_point.feature` (the no-job scenario at line 26 is deleted; the entry point is the `turn` mode),
`owner_observability.feature` (the supervisor emits the lifecycle lines now), `computer_owner_snapshot.feature` (the
stopped report is the supervisor's), `computer_owner_policy_coverage.feature`, `owner_role_policy.feature`,
`test/session-token.test.ts`, `test/session-tags.test.ts`, `test/container-owner-config.test.ts`,
`test/owner-session-env.test.ts`, `test/computer-starter-lambda.test.ts`, `test/computer-image-structure.test.ts`,
`test/route-audience.test.ts`. The list is the author's reading of the grep; the implementer finds the rest by running the
gates.
