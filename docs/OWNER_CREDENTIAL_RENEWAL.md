# Owner credential renewal (Phase 2b contract)

> **Status:** CONTRACT. Nothing on this page is built. It is the exact interface that the parts of Phase 2b are built
> against, after the Phase 2a contract ([Owner supervisor protocol](OWNER_SUPERVISOR_PROTOCOL.md)) and the Phase 3
> contract ([Live files protocol](LIVE_FILES_PROTOCOL.md)), both merged and live on development. Every claim about
> today's code carries a `file:line` reference into `origin/develop` at the time of writing; every statement about the
> proposal is the contract; a guess is labelled ASSUMPTION; a place where the earlier design is wrong or silent is
> labelled FLAG and listed in section 2. The wire schemas are in section 5 as the code Part P0 adds to
> [`host-protocol/src/supervisor.ts`](../host-protocol/src/supervisor.ts). The behavior is in the draft
> [`features/computer_owner_credential_renewal.feature`](../features/computer_owner_credential_renewal.feature)
> (not in `features/cucumber-features.txt`). The questions this page first left to the owner were answered; the answers are
> recorded as decisions in section 20 and applied throughout. Where this page and a section of [Long-lived computer](LONG_LIVED_COMPUTER.md) disagree, this page wins.

## 1. What Phase 2b is

Today an owner lives at most 50 minutes, because every credential it holds lasts one hour and nothing renews any of
them. The control plane drains it at 3000 seconds, the owner finishes or ends its turn within 300 seconds, publishes
within 120 seconds and stops, and the next message pays a cold start. Phase 2b lets one owner live up to eight hours by
renewing its credentials in place, and keeps every property that made the one-hour window safe: no credential lives
longer than an hour, the shell never sees any, and the control plane can end an owner by refusing its next renewal.

```
owner life (seconds after the bootstrap exchange)
0        2400       4800        7200  ...  26400        28200       28500     28620     28800
|---------|----------|-----------|-----------|-------------|-----------|---------|---------|
bootstrap  renew 1    renew 2     renew 3     renew 11      drain       watchdog  watchdog  hard
(set C0)   (set C1)   (set C2)    (set C3)    (set C11)     (lifetime)  TERM      KILL      end

C0 ends at 3600; C1 at 6000; C2 at 8400; ... C11 at 28800 (3600 would be 30000: the broker caps it at the hard end)
every renewal is asked for when 1200 seconds of the current set are left (40 minutes into its hour)
no renewal after 27900; the 12th would have been at 28800
```

Pieces, with what is new in bold:

```
Supervisor (root)
  holds in memory only: supervisor token, supervisor AWS credentials, the active turn's credentials
  **renews the first two every 2400 seconds, the third every 2400 seconds of the dispatch**
  **serves the active turn's credentials to its child over /run/chatticus/supervisor.sock**
    |
    `-- owner.mjs turn (root, one per turn)
          **env: no AWS key, no token. Reads them from the socket whenever the SDK asks.**

Front Door   **POST /host/owner/credentials: refuses unless the owner is the live owner, not draining, not stopping**
Broker       **new purpose supervisor_renewal; every credential it issues ends by the owner's hard end (8 h)**
```

### 1.1 What is live today (verified)

| Fact | Where |
| --- | --- |
| The supervisor gets AWS credentials and a supervisor token once, at the bootstrap exchange; the S3 client is built with those static credentials | `computer/host/src/supervisor.ts:226-233`, `supervisor-main.ts:105-115` |
| The credentials and the token end at the same moment (the minimum of the STS expiration and now + 3600) | `conversation/src/lambdas/owner-credential-broker.ts:165-166` |
| The server drains an owner 3000 seconds after the bootstrap consume; `3000` is `OWNER_MAX_LIFETIME_SECONDS` | `host-protocol/src/supervisor.ts:59`, `conversation/src/domain/owner-supervisor.ts:180-181,236,401` |
| The supervisor asks to stop as `unhealthy` 180 seconds before its credentials end (a single value set at bootstrap) | `supervisor.ts:48,232,276,318-321` |
| The child gets its credentials, and the gateway token, in its environment at fork | `computer/host/src/supervisor-child-environment.ts:44-48` |
| The child builds `new DynamoDBClient({})` and `new S3Client({})` from the default credential chain, and the gateway token is a fixed string | `computer/host/src/owner-deps.ts:65,70`, `owner-models.ts:57-65` |
| A per-turn child has no time limit: it ends when the turn ends | `conversation/src/turn/computer-owner.ts` (header comment) |
| The broker assumes with `DurationSeconds: 3600`, has no store, and its roles allow at most 3600 | `owner-credential-broker.ts:144`, `infra/lib/computer-host-start.ts:26,310` |
| The supervisor token opens a fixed list of routes; a stopped owner is accepted only for a repeated stopped report | `conversation/src/http/owner-host-auth.ts:27-37,190-197` |
| The poll only logs a protocol version below the minimum; nothing drains for it | `owner-supervisor.ts:243` |
| `OWNER_PROTOCOL_VERSION` is 2 (before 2b; it is 3 now and `OWNER_MINIMUM_PROTOCOL_VERSION` is 3 since the minimum was raised, section 19.1) | `host-protocol/src/supervisor.ts` |
| The in-container watchdog has the numbers 3300 and 3420 written into the script | `computer/chatticus-watchdog` (`terminate_after`, `kill_after`), tied to the constants by `conversation/test/computer-image-structure.test.ts` |
| `/run/chatticus` is root-owned, mode 0700, created by the supervisor | `supervisor-main.ts:79-80` |

### 1.2 Out of Phase 2b

| Not in 2b | Why |
| --- | --- |
| The external `OwnerLifetimeCheck` message chain with `ecs:StopTask` | Decided P5: not built. An alarm on `owner_overdue` replaces it (section 13). |
| Raising `OWNER_MINIMUM_PROTOCOL_VERSION` above 1 | The mechanism (drain with `drain_reason: "protocol_version"`) lands; using it was an operator change made only after the new image was promoted **and proven live**. Done after the live proof: the minimum is 3 (decision R17, decided P3, section 19.1). |
| Background processes, previews, two concurrent turns | Phases 4 and 5. Unchanged. |
| A longer credential for any single session | Every credential stays at most one hour (decision R5). |

## 2. Where the existing design is wrong or silent

Each row is something the earlier text says or leaves open that the live code contradicts or that must be decided before
anything is built. The right-hand column is where this page settles it.

| # | The design says | The live system says | Settled in |
| --- | --- | --- | --- |
| F1 | Section 6.5 and the Phase 2 list put the **bootstrap exchange** in 2b ("exchanged on the first poll"). | It is Phase 2a, on its own route, live (C1 of the 2a contract). | Phase 2b does not do it; `LONG_LIVED_COMPUTER.md` is corrected. |
| F2 | Section 6.5: "the child reads whichever credentials the supervisor currently holds over the local socket and never restarts to renew". | The child's credentials are environment variables fixed at fork (`supervisor-child-environment.ts:44-48`); an environment cannot be changed from outside a process; the clients are built from the default chain. With no credentials in the environment the default chain (the container credentials endpoint is not announced to the child) falls through to the instance metadata service, which a child must never use. | R10, R11, section 8.3. Every AWS client in the child gets an explicit provider. |
| F3 | Section 6.5 renews the **supervisor** credentials only. | A turn has no time limit (`computer-owner.ts`) and its gateway token and AWS credentials end after one hour. A turn longer than an hour dies on the first `ExpiredToken`, or on a 401 from the model gateway, however well the owner is renewed. | R2, R11, section 8.4. |
| F4 | Section 6.5: a stolen token "can renew only while the owner is the live generation and healthy, and never past the 8 hour cap". | Nothing in the live broker enforces a cap: it has no store and no anchor for the owner's start. Only the Front Door could. | R7, R8: the signed token carries the owner's start time and the broker enforces the hard end itself. |
| F5 | Section 6.8: "Maximum lifetime. 8 hours, then drain" and a watchdog that stops the task at "the cap plus a 30 minute grace". | An owner that is told to drain at 8 hours has a 300 second grace and a 120 second publish still to do, and its credentials must outlast both. A grace of 30 minutes past the cap lets credentials expire under a running owner. The drain happens at the cap minus the drain budget, not at the cap. | R4, R5, section 4. |
| F6 | Section 6.8: a drain "finishes the turn in hand (bounded at 10 minutes)". | The 2a contract decided 300 seconds (C9): the grace is part of an arithmetic that ends before the credentials do. | Constants are unchanged; section 4 shows the arithmetic. |
| F7 | `OWNER_MAX_LIFETIME_SECONDS` is a policy of 50 minutes. | 3000 is not a policy: it is the credential lifetime minus the drain budget (3600 - 300 - 120 - 180), hard-wired into `ownerLifetimeIsOver`. If the server simply raises it, an image from Phase 2a (which cannot renew) is cut off by expired credentials in the middle of a turn. | R4: the drain is **derived** from the credentials the server issued, which also makes any skew between server and image safe. |
| F8 | Section 8 of the 2a contract: the supervisor starts the final stop sequence 180 seconds before its credentials end. | The code does it with a single deadline and the stop reason `unhealthy` (`supervisor.ts:318-321`). With renewal that is wrong twice: it is a state, not a value (the credentials change), and `unhealthy` is an alarm. | R14, section 8.5. |
| F9 | Not mentioned: how the AWS SDK picks up new credentials. | `new S3Client({ credentials: { ..., expiration } })` is a constant; the SDK cannot refresh it. A **provider** is re-read only when the cached credentials are within 5 minutes of their expiration (`@smithy/core` `EXPIRATION_MS = 300_000`, `memoizeIdentityProvider`), and a provider that throws fails the request. | R13: the provider never throws while the credentials it holds are valid, and a renewal margin is far larger than 5 minutes. |
| F10 | Section 6.5 and the task: the control plane "refuses renewal after supersede". | The refusal is by the route authentication that already runs on every owner route (5.1 of the 2a contract), not by the broker, which reads no store (2a section 7). | R7. Decided S1: the broker stays store-free; the server checks the computer record before it invokes the broker. |
| F11 | Section 6.8: owners below a minimum protocol version "receive `drain: true`". | The poll only logs `owner_protocol_version_low`. Raising the minimum on the day the server is deployed, before the image is promoted, would drain every new owner (they all run the old image): the failure class of `COMPUTER_IMAGE_PROMOTION.md`. | R17: mechanism now, raising later. |
| F12 | The supervisor's loop is one `await` chain (`supervisor.ts:176-189`). | A renewal that waits for the broker (up to the 10 second request timeout) in the loop would stop the polls, and the 25 second fence (C17) would kill a healthy owner. | R3: a renewal is a second activity, like the overlay clear (`clearInFlight`). |
| F13 | Phase 2 live proof: "leave a computer up across a credential refresh". | An idle computer stops after 900 seconds (D2) and runs one turn at a time (D5). A renewal at 40 minutes is reached only with work at least every 15 minutes, and a long turn and keepalive messages cannot overlap on one computer (a parked turn waits at most 15 minutes). | Section 19. |
| F14 | Risk 4 of the design relies on an "independent watchdog message chain". | Not built: C10 of the 2a contract deferred it to 2b "load-bearing only when the cap rises to 8 hours". | R16 and decision P5: not built; an alarm on `owner_overdue` instead. |
| F15 | The design does not say whether an S3 request or multipart upload in flight when credentials change is safe. | Each request is signed when it starts; `S3SnapshotStore.putPack` sends every part as its own request (`snapshot/s3.ts:43-56`). | R12, A5. |
| F16 | The Phase 2a draft says the child's local channel is `/run/chatticus/supervisor.sock`, "mode 0600, root". | Mode 0600 on the file is enough only inside a directory the shell cannot enter, and only if the socket is a filesystem socket: Linux abstract sockets have no permissions and loopback TCP is open to every uid in the container's network namespace. | R12. |

## 3. Decisions

| # | Decision | Why |
| --- | --- | --- |
| R1 | **Renewal is a separate route**, `POST /host/owner/credentials`, not a field of the poll. One route, discriminated by `kind`: `supervisor` or `turn`. | The poll is the heartbeat. It must stay cheap, idempotent per `sequence`, and answerable when the owner is draining or stopping. A renewal calls STS through a Lambda (hundreds of milliseconds, sometimes seconds) and is allowed or refused by lifecycle rules the poll must not have. If the broker is slow or throttled, a renewal folded into the poll would turn a heartbeat into a failure and the fence (25 s) would kill a healthy owner. A repeated poll (same `sequence`) would mint a new grant on each repeat. The route costs one entry in `OWNER_COMPUTER_ROUTES` and one `declareRoute`. |
| R2 | Two kinds: `supervisor` returns new AWS credentials **and** a new supervisor token (one broker call, both end at the same moment); `turn` returns new per-turn AWS credentials **and** a new gateway token for the dispatched turn. | The token and the credentials must never disagree about expiry: a token that outlives its credentials, or the reverse, makes the stop sequence fail in the middle (the stopped report needs the token, the final publish needs the credentials). |
| R3 | **The supervisor decides when**: it asks when 1200 seconds of its credentials remain (40 minutes in). The server keeps the final say by refusing (R6) and by draining (R4). The renewal runs as its own activity, never in the poll loop. | One owner clock for scheduling, one server clock for authority (the principle of C6). The margin is large against clock skew, against the 5 minute window in which the SDK re-reads a provider (F9), and against ten minutes of retries (section 10). No poll field is needed. |
| R4 | **The drain is derived from the credentials the control plane issued**: drain when `credentialsExpireAt - now <= 600`, or when `now - ownerStartedAt >= OWNER_MAX_LIFETIME_SECONDS` (28200), or when the owner's protocol version is below the minimum. The record keeps `ownerCredentialsExpireAt`, written at the bootstrap consume and at each renewal. | One rule serves every case: an owner that renews lives on; one that cannot (an image from Phase 2a, or a failed renewal) drains 600 seconds before its credentials end, exactly as today (3600 - 600 = 3000). The invariant "the owner is gone before its credentials expire" holds for any image against any server. |
| R5 | **No credential, token or process lives past the hard end**: `OWNER_HARD_LIFETIME_SECONDS = 28800` after the bootstrap. Every single credential still lasts at most one hour. `OWNER_MAX_LIFETIME_SECONDS` becomes 28200 (hard end minus the 600 second drain budget). Nothing is issued in the last 900 seconds (the STS minimum session), at 27900. | "At most 8 hours" is a bound on the whole owner. The drain starts early enough for the grace and the publish to finish inside it. The cutoff means the AWS credentials never outlive the hard end either. |
| R6 | **A renewal is refused** when the owner is not the live owner (every owner route already checks this), when a stop is approved (`owner_stopping`), when the control plane is draining it (supervisor kind only: a draining owner may still renew the credentials of the turn it is finishing), or after the issuance cutoff (`owner_draining`), and when asked again within 60 seconds for the same kind (`renewal_too_soon`, 429). Once refused for a drain, the refusal is final: the drain never reverses. | A stopped or replaced owner must not receive fresh S3 write credentials for a disk a newer owner now holds. A drain that could be undone by a late renewal would leave the supervisor and the server disagreeing about whether the owner is stopping. |
| R7 | **The Front Door decides, the broker bounds.** The broker keeps reading no store. For `supervisor_renewal` it verifies the supervisor token (audience, signature, expiry), requires the payload to equal the token's claims, builds the same two tags from the verified payload, assumes the same role with the same session name, and refuses past the token's hard end. | The broker's value is that a Front Door bug cannot name another owner or another computer, and (new) cannot extend one past the hard end. Giving it the store would add a data store to a function meant to have none (2a 12.3). **Decided (S1):** it stays store-free; the Front Door reads the computer record and refuses before it invokes the broker (6.2 steps 2 and 3). |
| R8 | **The supervisor token carries the owner's start time**: a new required claim `ownerStartedAtSeconds` of the supervisor token. The broker sets it at the bootstrap and copies it at every renewal; it computes the hard end from it. | The only way for a store-free broker to enforce a cap is a signed anchor. Cost: the strict claims schema changes, so tokens of the previous format are refused and the first merge needs no running owner (section 18). **Decided (S2):** the broker requires the claim and refuses a token without it (`invalid_authorization`). |
| R9 | The renewal request is limited to one per kind per 60 seconds, per owner, by a compare-and-set on the computer record; a lost response can therefore be retried successfully only 60 seconds after the lost one was recorded. The grant that a lost response carried is never used and expires. | STS and Lambda cost nothing at this rate and a loop in a faulty supervisor can do no more than 60 calls an hour. The record already carries the owner's other state; no new store. |
| R10 | **The child holds no credential in its environment.** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `CHATTICUS_MODEL_GATEWAY_TOKEN` leave `OWNER_CHILD_ENVIRONMENT_NAMES` and join the forbidden list; `CHATTICUS_SUPERVISOR_SOCKET` joins the allowed list. | One path, no "env first, socket as a fallback". It also removes the exposure of `/proc/<child>/environ`. A client built without an explicit provider fails closed. |
| R11 | **The supervisor renews the active turn's credentials on a timer** (1200 seconds before they end, the same schedule as its own) and the child only reads them: the child never renews and never calls the control plane. | A child that renewed would need a host token, which C3 of the 2a contract deleted. The child stays a pure reader with a smaller attack surface. |
| R12 | **The channel is a Unix domain socket on a filesystem path** `/run/chatticus/supervisor.sock`, mode 0600, inside the 0700 directory. Never an abstract socket, never TCP. One operation: read the active dispatch's turn credentials. It never returns the supervisor's own credentials or token. | The shell (uid 2000) cannot enter the directory. Loopback TCP is reachable from every uid in the container; abstract sockets have no permission check. A compromised child can read only what it already held. |
| R13 | **Atomic swap**: the AWS credentials and the supervisor token are replaced in one synchronous step (no `await` between), after the whole response has been parsed and checked newer than what is held. The S3 client is built once with a provider that returns the holder's current credentials; the provider never throws while the credentials it holds are valid. | An in-flight request keeps the credentials it was signed with; the next one uses the new. No request can mix an old token with new credentials, and the SDK's memoization (F9) only delays the adoption, never breaks it. |
| R14 | **The supervisor drains itself** when 600 seconds of its credentials remain and no renewal has succeeded, asks to stop with a new reason `credentials` (always approved), and has a **hard deadline** 30 seconds before the credentials end, at which it kills the child and exits with code 9. | The server's stored expiry can differ from the supervisor's (a renewal whose response was lost). The supervisor must not wait for a drain it will not be told about, and a stop that hangs must not outlive the credentials it needs. |
| R15 | **A renewal is not work.** It does not touch the idle clock, a dispatch, a file operation or the stop veto. An owner lives 40 minutes only if work arrives at least every 15 minutes (or a turn runs). | The idle timeout stays the bound on cost (D1, D2). Renewal must never make an unused computer last longer. |
| R16 | **The external `OwnerLifetimeCheck` chain stays deferred.** The Front Door logs `owner_overdue` for a live owner older than the hard lifetime plus the drain budget, and a metric filter alarms on it. | An owner that outlives 28800 seconds needs the idle timer, the drain, the in-container watchdog (which a wedged Node loop cannot affect) and its credentials to all fail. The chain adds a permission (`ecs:StopTask`) and a message type for that case alone. **Decided (P5):** not built. |
| R17 | `OWNER_PROTOCOL_VERSION` becomes 3 in the change that renews. The drain for a version below `OWNER_MINIMUM_PROTOCOL_VERSION` is implemented (`drain_reason: "protocol_version"`); the minimum stayed 1 in the rollout and was raised to 3 after the live proof (section 19.1). Lifetime does not branch on the version (R4 makes it unnecessary). | A gate on the version for lifetime would be the "support both ways" fork the project forbids, and raising the minimum with the server deploy would drain every new owner until the image moves (F11). |
| R18 | **No change to either role, to the trust policies, to `maxSessionDuration`, to any permission of the broker, or to the real-IAM manifest.** A renewal is an `AssumeRole` of the same role, with the same tags, by the same principal, for `DurationSeconds` between 900 and 3600. | Nothing the roles may touch changes. Section 15. |
| R19 | **Tokens stay stateless.** A renewed owner's earlier token stays valid until its own expiry (at most an hour). There is no rotating serial. | A serial would be checked on every request and need a two-token grace for a lost response, which leaves the previous token valid for as long as the expiry does. **Decided (S3):** accepted. |
| R20 | **The role session name is stable for an owner**: `supervisor-<ownerId>` at bootstrap and at every renewal; `turn-<ownerId>` for every turn grant. | The assumed-role principal ARN is the same across renewals, so an S3 multipart upload begun with one set of credentials may be continued with the next (A5), and CloudTrail correlates the sessions of one owner. |
| R21 | Once the supervisor is `stopping`, it starts no renewal and abandons one in flight. | The stop sequence runs on what it holds (it has at least 180 seconds by R14). A late renewal would only be refused. |
| R22 | A **development-only fault switch** in the broker can shorten the supervisor credentials to 900 seconds and can deny renewals. **Decided (P4): built.** It is gated off outside development at build time and at runtime, by four gates: (G1) the CDK context `ownerBrokerFault` / `ownerBrokerCredentialSeconds` is read only when the environment name is `development`, and synthesis throws, naming the switch, if either is set for staging or production; (G2) the stack emits the broker variables `CHATTICUS_OWNER_BROKER_FAULT` and `CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS` only in development, and always sets `CHATTICUS_ENVIRONMENT` on the broker; (G3) at runtime the broker's single fault module (`conversation/src/lambdas/owner-credential-broker-faults.ts`, the only reader of the two variables) throws at initialization if either variable is set and `CHATTICUS_ENVIRONMENT` is not exactly `development` (a missing value counts as not development), so the function fails closed on every invocation; (G4) a fault can only make the broker issue less (deny a purpose, or a duration between 900 and 3600 seconds, never longer) and never changes who is authorized. | The failure path and the swap across a real expiry can then be proved live in 15 minutes instead of 80. Two tests keep production from enabling it: the scenario "The broker refuses to start with a fault switch outside development" and a structural vitest test (`conversation/test/broker-fault-gate.test.ts`, section 15). |

## 4. Constants

All in `host-protocol/src/supervisor.ts`. Nothing is read from the environment except where noted. Values that change are
marked; the others exist and are listed because the arithmetic uses them.

| Constant | Value | Used by |
| --- | --- | --- |
| `OWNER_HARD_LIFETIME_SECONDS` (new) | 28800 | broker (hard end), server (cutoff, `owner_overdue`) |
| `OWNER_LIFETIME_MARGIN_SECONDS` (new) | 180 | the budget below; the supervisor's former `CREDENTIAL_STOP_MARGIN` |
| `OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS` (new) | `OWNER_DRAIN_GRACE_SECONDS + OWNER_FINAL_PUBLISH_BUDGET_SECONDS + OWNER_LIFETIME_MARGIN_SECONDS` = 600 | server (drain), supervisor (local drain) |
| `OWNER_MAX_LIFETIME_SECONDS` (**changes**) | `OWNER_HARD_LIFETIME_SECONDS - OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS` = 28200 (was 3000) | server (drain), watchdog |
| `OWNER_DRAIN_GRACE_SECONDS` | 300 | unchanged |
| `OWNER_FINAL_PUBLISH_BUDGET_SECONDS` | 120 | unchanged |
| `OWNER_CREDENTIAL_LIFETIME_SECONDS` | 3600 | broker (longest single session), unchanged |
| `OWNER_BROKER_MINIMUM_SESSION_SECONDS` (new) | 900 | broker (the STS floor), server |
| `OWNER_ISSUANCE_CUTOFF_SECONDS` (new) | `OWNER_HARD_LIFETIME_SECONDS - OWNER_BROKER_MINIMUM_SESSION_SECONDS` = 27900 | server (no renewal, no dispatch after it), broker (`owner_lifetime_over`) |
| `OWNER_CREDENTIAL_RENEWAL_MARGIN_SECONDS` (new) | 1200 | supervisor (start renewing) |
| `OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS` (new) | 60 | server (429) |
| `OWNER_CREDENTIAL_RENEWAL_RETRY_SECONDS` (new) | `[15, 30, 60]`, then 60 repeated | supervisor |
| `OWNER_CREDENTIAL_HARD_DEADLINE_MARGIN_SECONDS` (new) | 30 | supervisor (exit 9) |
| `OWNER_SUPERVISOR_SOCKET_PATH` (new) | `/run/chatticus/supervisor.sock` | supervisor, child |
| `OWNER_PROTOCOL_VERSION` (**changes**) | 3 (was 2), in the change that renews | supervisor |
| `OWNER_MINIMUM_PROTOCOL_VERSION` | 1 in the rollout; 3 after the live proof (section 19.1) | server |
| `OWNER_WATCHDOG_TERMINATE_SECONDS` (**derived, changes**) | `OWNER_MAX_LIFETIME_SECONDS + OWNER_DRAIN_GRACE_SECONDS` = 28500 (was 3300) | watchdog script, image test |
| `OWNER_WATCHDOG_KILL_SECONDS` (**derived, changes**) | terminate + `OWNER_FINAL_PUBLISH_BUDGET_SECONDS` = 28620 (was 3420) | watchdog script, image test |
| `OWNER_CHILD_ENVIRONMENT_NAMES`, `OWNER_CHILD_FORBIDDEN_ENVIRONMENT_NAMES` (**change**) | see R10 | supervisor, tests |

Declaration order in the file changes: `OWNER_DRAIN_GRACE_SECONDS` and `OWNER_FINAL_PUBLISH_BUDGET_SECONDS` must be declared
before the constants derived from them.

**The arithmetic, for credentials that end at E (the minimum of the AWS expiration and the token expiry):**

| Moment | What happens |
| --- | --- |
| E - 1200 | the supervisor starts asking for new credentials (R3) |
| E - 600 | the server drains the owner if no renewal was recorded, refuses renewals, and the supervisor drains itself (R4, R14) |
| E - 300 | the drain grace is over; the child is ended (SIGTERM, 10 seconds, SIGKILL) |
| E - 180 | the final publish (120 second budget) and the stopped report should be done |
| E - 30 | the hard deadline: the supervisor kills the child and exits with code 9 |
| E | the credentials and the token end |

`E <= hard end` always, because the broker never issues past it (section 7). At the hard end itself the last set ends at
28800 (renewal 11 at 26400 is capped), the drain is by lifetime at 28200 and by credentials at 28200 as well, the watchdog
terminates at 28500 and kills at 28620, all before 28800. The watchdog's clock starts at the supervisor's first action,
which is up to 120 seconds (the bootstrap retry window) before the bootstrap exchange; in that worst case it terminates at
28380, inside the drain grace, which is the same graceful path as SIGTERM.

## 5. Wire schemas

The code below is what Part P0 adds to `host-protocol/src/supervisor.ts`, with a test of every schema in
`conversation/test/owner-supervisor-protocol-schema.test.ts`. Names not shown are unchanged. The block shows the final
state: P0 adds the new names and leaves `OWNER_MAX_LIFETIME_SECONDS` at 3000 and `OWNER_PROTOCOL_VERSION` at 2; Part A1 replaces
the lifetime with the formula, and Part C raises the version (section 17).

```ts
/** Seconds after the bootstrap exchange at which nothing the owner holds is valid: no token, no credential. Eight hours. */
export const OWNER_HARD_LIFETIME_SECONDS = 28800;

/** Seconds of a margin the stop sequence keeps before credentials end. */
export const OWNER_LIFETIME_MARGIN_SECONDS = 180;

/** Seconds before the end of the credentials at which an owner must be draining: the grace, the final publish and a margin. */
export const OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS = OWNER_DRAIN_GRACE_SECONDS + OWNER_FINAL_PUBLISH_BUDGET_SECONDS + OWNER_LIFETIME_MARGIN_SECONDS;

/** Seconds from the bootstrap exchange until the control plane drains an owner whose credentials were renewed all the way. */
export const OWNER_MAX_LIFETIME_SECONDS = OWNER_HARD_LIFETIME_SECONDS - OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS;

/** The shortest session STS issues; the broker issues nothing in the last this many seconds of the hard lifetime. */
export const OWNER_BROKER_MINIMUM_SESSION_SECONDS = 900;

/** Seconds after the bootstrap exchange from which no renewal is granted and no dispatch is offered. */
export const OWNER_ISSUANCE_CUTOFF_SECONDS = OWNER_HARD_LIFETIME_SECONDS - OWNER_BROKER_MINIMUM_SESSION_SECONDS;

/** Seconds of remaining credentials at which the supervisor starts asking for new ones. */
export const OWNER_CREDENTIAL_RENEWAL_MARGIN_SECONDS = 1200;

/** Seconds that must pass between two renewals of the same kind for one owner. */
export const OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS = 60;

/** Pauses, in seconds, between the attempts of a renewal that fails; the last repeats. */
export const OWNER_CREDENTIAL_RENEWAL_RETRY_SECONDS = [15, 30, 60] as const;

/** Seconds before its credentials end at which a supervisor kills everything and exits. */
export const OWNER_CREDENTIAL_HARD_DEADLINE_MARGIN_SECONDS = 30;

/** Where the supervisor listens for its child. A filesystem socket inside a directory only root can enter. */
export const OWNER_SUPERVISOR_SOCKET_PATH = "/run/chatticus/supervisor.sock";
```

The supervisor token gains one claim (strict schema, so it is required):

```ts
export const computerOwnerTokenClaimsSchema = z
	.object({
		audience: z.literal(COMPUTER_OWNER_AUDIENCE),
		tenantId: identifier,
		computerId: identifier,
		ownerId: identifier,
		startGeneration: generation,
		/** When the owner's bootstrap exchange was granted, in seconds since the epoch; every renewal keeps it, and the broker ends every credential by this plus the hard lifetime. */
		ownerStartedAtSeconds: z.number().int().positive(),
		issuedAtSeconds: z.number().int().nonnegative(),
		expiresAtSeconds: z.number().int().positive(),
	})
	.strict();
```

Error codes and statuses:

```ts
// ownerErrorCodeSchema gains:
"owner_draining",     // 409: the control plane is draining this owner, or the issuance cutoff passed. Final.
"owner_stopping",     // 409: a stop was approved. Final.
"renewal_too_soon",   // 429: the same kind was renewed within OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS.
"turn_not_served",    // 409: the dispatch or the turn is not the one this owner is serving.

// OWNER_ERROR_STATUS gains the four entries, and its value type becomes 401 | 403 | 409 | 422 | 429 | 503.
```

The route:

```ts
/** POST /orgs/{tenant}/host/owner/credentials: the supervisor asks for the next set of credentials, its own or its turn's. */
export const ownerCredentialsRequestSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("supervisor"), owner_id: identifier, generation }).strict(),
	z
		.object({ kind: z.literal("turn"), owner_id: identifier, generation, dispatch_id: identifier, turn_id: identifier })
		.strict(),
]);

/** The next set. Both kinds end their token and their credentials at the same moment, never later than the owner's hard end. */
export const ownerCredentialsResponseSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("supervisor"),
		supervisor_token: z.string().min(1),
		supervisor_token_expires_at: timestamp,
		aws_credentials: awsCredentialsSchema,
	}),
	z.object({
		kind: z.literal("turn"),
		dispatch_id: identifier,
		turn_id: identifier,
		gateway_token: z.string().min(1),
		aws_credentials: awsCredentialsSchema,
		expires_at: timestamp,
	}),
]);

/** A stop reason for an owner that could not renew its credentials: always approved, whatever is pending. */
export const ownerStopReasonSchema = z.enum(["idle", "lifetime", "unhealthy", "credentials"]);
```

The broker (section 7):

```ts
// ownerCredentialBrokerRequestSchema gains a third purpose, same fields as "supervisor", whose authorization is the SUPERVISOR token:
z.object({ ...brokerBase, purpose: z.literal("supervisor_renewal") }).strict(),

// ownerCredentialBrokerResponseSchema gains the matching success:
z.object({
	ok: z.literal(true),
	purpose: z.literal("supervisor_renewal"),
	aws_credentials: awsCredentialsSchema,
	supervisor_token: z.string().min(1),
	supervisor_token_expires_at: timestamp,
}),

// ownerCredentialBrokerErrorCodeSchema gains:
"owner_lifetime_over",   // the owner's hard end is less than OWNER_BROKER_MINIMUM_SESSION_SECONDS away, or past
```

The local socket (newline-delimited JSON, one request and one answer per connection, a request of at most 1 KiB and an answer the child reads up to 16 KiB of):

```ts
/** What the per-turn child asks its supervisor for over the socket. The dispatch id is the one in its environment. */
export const ownerSocketRequestSchema = z.object({ v: z.literal(1), op: z.literal("turn_credentials"), dispatch_id: identifier }).strict();

export const ownerSocketResponseSchema = z.union([
	z.object({ ok: z.literal(true), aws_credentials: awsCredentialsSchema, gateway_token: z.string().min(1), expires_at: timestamp }),
	z.object({ ok: z.literal(false), code: z.enum(["no_turn", "expired"]) }),
]);
```

`no_turn`: the dispatch is not the one being served (or none is). `expired`: the supervisor holds credentials for it but they
are past their end because renewals failed. Neither carries a secret.

The child's environment lists change (R10):

```ts
// OWNER_CHILD_ENVIRONMENT_NAMES: remove CHATTICUS_MODEL_GATEWAY_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN; add CHATTICUS_SUPERVISOR_SOCKET.
// OWNER_CHILD_FORBIDDEN_ENVIRONMENT_NAMES: add CHATTICUS_MODEL_GATEWAY_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI.
```

## 6. The control plane

### 6.1 Route and authentication

| Method and path | Audience | Authentication | Request | Response (200) | Refusals |
| --- | --- | --- | --- | --- | --- |
| `POST /owner/credentials` | `computer-owner` | supervisor token | `ownerCredentialsRequestSchema` | `ownerCredentialsResponseSchema` | 401; 403 `wrong_organization`, `credential_mismatch`, `stale_generation`, `not_current_owner`; 409 `owner_draining`, `owner_stopping`, `turn_not_served`; 422; 429 `renewal_too_soon`; 503 `credentials_unavailable` |

The route joins `OWNER_COMPUTER_ROUTES` (`owner-host-auth.ts:27-37`) and is declared with audience `computer-owner`. Its
authentication is step 1 to 7 of 5.1 of the 2a contract, unchanged: the token must be unexpired (a renewal needs a token that
is still valid, so an owner that let its token lapse is gone), minted for the organization of the path, and the owner it names
must be the live owner of the current generation. **The stopped replay of 5.1 step 6 is not extended to this route**
(`authenticateOwnerHostRequest` allows it for `POST /computer/state` only, `owner-host-auth.ts:190-197`); a scenario pins it.

### 6.2 Handler order

After authentication:

1. Validate the body (422 `invalid_request`). `owner_id` and `generation` equal the token's (403 `credential_mismatch`).
2. Read the computer record; it must still name this owner (403 `not_current_owner`, as `requireLiveComputer`).
3. **Lifecycle.** `ownerStopApprovedAt` set: 409 `owner_stopping`.
   - `kind: supervisor`: `ownerDrainReason(computer, now)` is not null, or `now - ownerStartedAt >= OWNER_ISSUANCE_CUTOFF_SECONDS`:
     409 `owner_draining`.
   - `kind: turn`: the cutoff applies the same way (409 `owner_draining`); a **drain does not refuse** a turn renewal (a draining
     owner is finishing its turn inside the grace and its child needs credentials until it ends). The dispatch must be the
     stored one (`dispatch_id` equals `dispatchId`, `turn_id` equals `dispatchTurnId`), and its turn must be `active`,
     `claimedBy` this owner, with an unexpired attempt lease; else 409 `turn_not_served`.
4. **Rate limit.** `ownerCredentialsRenewedAt` (supervisor) or `dispatchCredentialsRenewedAt` (turn) newer than
   `now - OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS`: 429 `renewal_too_soon`. The broker is not asked.
5. **Ask the broker**: `supervisor_renewal` with `authorization` = the presented supervisor token, or `turn` with the turn's
   bot and channel from the turn record and the same authorization. `OwnerCredentialBrokerError` with
   `owner_lifetime_over` is 409 `owner_draining`; any other broker failure is 503 `credentials_unavailable`. Nothing is
   recorded, so the owner may ask again at once (the rate limit counts only recorded grants).
6. **Record** with one conditional update (`renewOwnerCredentials`, section 6.3): the owner is still live, no stop is
   approved, and the renewal attribute still has the value read in step 4. A failed condition discards the grant unseen: 409
   `owner_stopping` if a stop was approved meanwhile, 403 `not_current_owner` if the owner ended or was replaced meanwhile,
   409 `turn_not_served` (turn kind) if a new dispatch replaced the one named, otherwise 429 `renewal_too_soon`. The
   `owner_credentials_refresh_failed` Front Door line records the broker's code when the broker could not serve. For `supervisor` the update also
   sets `ownerCredentialsExpireAt` to `min(aws_credentials.expires_at, supervisor_token_expires_at)`.
7. Respond 200. Log `owner_credentials_refresh_ok` (section 13).

Mint-then-record is the order of the bootstrap exchange (5.2 step 8 of the 2a contract) for the same reason: a renewal that
loses a race costs one STS call and delivers nothing.

### 6.3 Records

`Computer` (`store/codecs/computer.ts`) gains optional fields, cleared with `ownerId` (`setComputerStopped(true)`,
`settleLostComputerHost`, `claimHostStartGeneration`) and overwritten at the bootstrap consume:

| Field (attribute) | Type | Written by | Cleared by |
| --- | --- | --- | --- |
| `ownerCredentialsExpireAt` (`owner_credentials_expire_at`) | epoch seconds | bootstrap consume (from the grant), supervisor renewal | with `ownerId` |
| `ownerCredentialsRenewedAt` (`owner_credentials_renewed_at`) | epoch seconds | supervisor renewal | with `ownerId`, bootstrap |
| `dispatchCredentialsRenewedAt` (`dispatch_credentials_renewed_at`) | epoch seconds | turn renewal | with the `dispatch*` fields, and by every `offerOwnerDispatch` (a new offer starts the limit over) |

Store changes: `consumeOwnerBootstrap` takes `credentialsExpireAt`; `renewOwnerCredentials(tenantId, ownerId, generation,
change)` where `change` is `{ kind: "supervisor"; seenRenewedAt: Date | null; renewedAt: Date; credentialsExpireAt: Date }` or
`{ kind: "turn"; dispatchId: string; seenRenewedAt: Date | null; renewedAt: Date }`, true when it applied. Condition:
`owner_id = :o AND owner_generation = :g AND attribute_not_exists(owner_stop_approved_at) AND (attribute_not_exists(<renewed
attribute>) OR <renewed attribute> = :seen)` and, for a turn, `dispatch_id = :d`. The per-turn role's `MessagingWritable`
statement still allows the computer record (`owner-role-policy.json:50`); these fields are written by the Front Door.

### 6.4 The drain, derived

Replaces `ownerLifetimeIsOver` (`owner-supervisor.ts:180`). The reasons are the strings of `drain_reason`:

```ts
export type OwnerDrainReason = "protocol_version" | "lifetime" | "credentials";

export function ownerDrainReason(computer: Computer, now: Date, minimumProtocolVersion: number): OwnerDrainReason | null {
	if (computer.ownerProtocolVersion !== undefined && computer.ownerProtocolVersion < minimumProtocolVersion) return "protocol_version";
	if (computer.ownerStartedAt !== undefined && secondsBetween(now, computer.ownerStartedAt) >= OWNER_MAX_LIFETIME_SECONDS) return "lifetime";
	if (computer.ownerCredentialsExpireAt !== undefined && secondsBetween(computer.ownerCredentialsExpireAt, now) <= OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS) return "credentials";
	return null;
}

export function ownerIssuanceClosed(computer: Computer, now: Date): boolean {
	return computer.ownerStartedAt !== undefined && secondsBetween(now, computer.ownerStartedAt) >= OWNER_ISSUANCE_CUTOFF_SECONDS;
}
```

`minimumProtocolVersion` is a dependency of `pollOwner` (default `OWNER_MINIMUM_PROTOCOL_VERSION`) so a scenario can raise it.
The reasons are ordered as written; a drain never reverses (the inputs only move one way once the owner is not renewed, and a
renewal is refused once any reason holds).

What uses it:

- **Poll** (step 5 of 5.3 of the 2a contract): `drain = ownerDrainReason(...) !== null`; `drain_reason` is the reason. Dispatch
  (step 6) additionally requires `!ownerIssuanceClosed(computer, now)`: in the last 900 seconds nothing is offered, because
  the broker would refuse. The server logs `owner_dispatch_withheld reason=issuance_cutoff` once per owner, not per poll.
- **Stop request** `lifetime`: approved when `ownerDrainReason(...) !== null`, whatever the reason (the stop reason names the
  order, not the cause; a 2a supervisor that is told `drain_reason: "credentials"` is an unknown string to it and drains
  all the same, `supervisor.ts:429`). `credentials` and `unhealthy`: always approved.
- **`owner_overdue`**: on a poll, if `now - ownerStartedAt >= OWNER_HARD_LIFETIME_SECONDS`, one log line per poll with the age.
  A metric filter alarms on it (section 13).

For an owner that never renews (an image of Phase 2a), `ownerCredentialsExpireAt` is the bootstrap grant's expiry, about 3600
seconds after the consume, so it is drained at about 3000 seconds exactly as before. Existing scenarios stay green if their
steps set `ownerCredentialsExpireAt` where they set `ownerStartedAt` (section 21).

### 6.5 Protocol-version drain

The 2a poll logs `owner_protocol_version_low`; that line is replaced by the drain above. A drained owner is offered no dispatch
(the existing refinement of `ownerPollResponseSchema`), finishes its turn inside the grace, publishes and stops. The minimum
stayed 1 when this landed (R17) and is 3 after the live proof (section 19.1). An owner below the minimum is not refused at the bootstrap: the bootstrap stores the version it announced, and the next poll is answered with `drain: true`, `drain_reason: "protocol_version"` and no dispatch.

## 7. The credential broker

Changes to `conversation/src/lambdas/owner-credential-broker.ts` (section 7 of the 2a contract is otherwise unchanged):

| Step | `supervisor` (bootstrap) | `supervisor_renewal` (new) | `turn` |
| --- | --- | --- | --- |
| Authorization | bootstrap token | **supervisor token** (audience `computer-owner`, unexpired, signature) | supervisor token |
| Claims equal payload | tenant, computer, owner, generation | the same | the same |
| Anchor | `ownerStartedAtSeconds = now` (the broker's clock) | **copied from the token** | read from the token |
| Hard end | `anchor + 28800` | `anchor + 28800` | `anchor + 28800` |
| Refuse | | `hardEnd - now < 900`: `owner_lifetime_over` (a session of exactly 900 seconds is granted) | the same |
| Tags | `supervisorSessionTags` | the same two tags, from the verified payload | `ownerSessionTags`, five |
| `RoleSessionName` | `supervisor-<ownerId>` | `supervisor-<ownerId>` (R20) | `turn-<ownerId>` |
| `DurationSeconds` | 3600 | `min(3600, hardEnd - now)` (at least 900 by the refusal) | `min(3600, hardEnd - now)` |
| Token expiry | `min(now + 3600, floor(STS expiration))` | `min(now + duration, floor(STS expiration))` | the same |

The role, the absence of a session policy and the fixed ARNs are unchanged. No credential the broker issues ends after the
hard end, because the duration is cut to it and refused when it would be shorter than STS allows. The broker still reads no
store; it cannot tell whether the owner is superseded, stopping or draining. **The Front Door tells it by not asking** (6.2
step 3), and the signed anchor bounds a Front Door fault (R7, R8). It still never logs a token, a key or a credential; its
lines gain `purpose: supervisor_renewal` and `duration_seconds`.

The Front Door's port (`conversation/src/computer/owner-credential-broker.ts`) gains the overload for
`supervisor_renewal` returning `SupervisorGrant`; `FakeOwnerCredentialBroker` handles the purpose, enforces the same hard
end, records every request and can hold an answer until a step releases it.

### 7.1 AssumeRole chaining

STS caps a role session obtained by assuming a role **with credentials that are themselves an assumed-role session** at one
hour ("role chaining"). The broker's own credentials are its Lambda execution role, so its `AssumeRole` of the two owner
roles is the first hop, and the roles' `maxSessionDuration` (3600, `computer-host-start.ts:26`) is what limits it today.
Phase 2b does not depend on either fact being different:

- Every credential issued is at most 3600 seconds. A longer session is not needed because renewal exists, and it is not
  wanted: **an IAM role session cannot be revoked for one tenant** (the only revocation is a deny on `aws:TokenIssueTime`
  attached to the role, which hits every tenant). Renewal is what makes "stop the owner" mean "its credentials are gone
  within the hour".
- The supervisor and the child never call STS. If the supervisor assumed the per-turn role itself it would be chaining (an
  hour at most) and its role would need `sts:AssumeRole`, which would let a leaked supervisor credential mint turn
  credentials. They ask the Front Door, which asks the broker.
- ASSUMPTION A1: whether a Lambda execution role's `AssumeRole` is treated as chained is not verified here and not needed.

## 8. The container

### 8.1 Holders and the atomic swap

```ts
/** The credentials one holder serves right now. Replaced as a whole; never mutated. */
export class CredentialHolder<T extends { readonly expires_at: string }> {
	current(): T;
	replace(next: T): void;
}
```

- **AWS credentials.** `openDisk` receives the provider, not a value: `openDisk(credentials: () => Promise<AwsCredentialIdentity>)`
  and `supervisor-main.ts` builds `new S3Client({ credentials: provider })` once. The `S3SnapshotStore` and the
  `S3OverlayBlobReader` share that client. The provider returns the holder's current credentials with their `expiration`
  and throws only when they are past their end (F9).
- **Token.** `OwnerSupervisorClient` gains `replaceBearerToken(token)`; the next request reads it. The `SupervisorPlane` port
  declares it too, so the supervisor can call it in the same synchronous step as the credentials; the type of the provider
  is `StorageCredentialsProvider` in `supervisor-ports.ts`.
- **The swap.** On a renewal answer, in one synchronous function: parse the whole body with `ownerCredentialsResponseSchema`
  (done by the client), check `kind` matches what was asked and the new expiry is later than the held one, then replace the
  credentials, replace the token, set the new expiry and state, log. No `await` inside, so the event loop cannot interleave a
  request between the two replacements.
- **What is in flight.** A request signs when it starts. A multipart upload (`putPack` sends `CreateMultipartUpload`, each
  `UploadPart` and `CompleteMultipartUpload` as separate requests) may straddle the swap: its parts are signed by whichever
  credentials are current when each starts, and the principal is the same assumed-role ARN (R20). A hydrate (one `GetObject`
  stream) or a single `PutObject` that began before the swap finishes with the credentials it began with (ASSUMPTION A4: S3
  authorizes at the start of a request; if it did not, the publish fails, is logged, and is retried at the next trigger as any
  publish failure is). The SDK adopts the new credentials no later than 5 minutes before the old ones end (F9); the renewal
  runs 20 minutes before, so there are 15 minutes in which the old credentials are still valid and the new ones are held.
- The first hydrate runs within the first minutes after the bootstrap; renewals begin at 40 minutes. They do not meet.

### 8.2 The renewal loop

A `CredentialLease` (one for the supervisor, one for the active turn) has `expiresAtMilliseconds`, a single in-flight
request, and `consecutiveFailures`. The supervisor's loop gains deadlines (`waitForNextEvent`) and one step in `doDueWork`:

- Due when `expiresAt - now <= 1200 s`, no request is in flight, the next attempt time has come (never less than 60 seconds
  after the previous success, the server's own limit), and the supervisor is not `stopping` (R21). The request is started with `void` and a `.finally` that wakes the loop, like `clearInFlight`
  (`supervisor.ts:139,502-507`). It runs concurrently with polls and with file operations.
- On success: swap (8.1), reset `consecutiveFailures`, log `owner_credentials_refreshed`.
- On failure: `consecutiveFailures += 1`, log `owner_credentials_refresh_failed`, next attempt after
  `OWNER_CREDENTIAL_RENEWAL_RETRY_SECONDS[min(failures, 3) - 1]` seconds. Within the 600 seconds before the drain that is about
  twelve attempts.
- The request carries the supervisor token and `X-Chatticus-Host-User-Id` like every owner request, and the 10 second timeout
  of the client (`protocol-client.ts` `requestTimeoutMilliseconds`).
- Refusals: section 10.

### 8.3 The socket and the child

The supervisor creates the socket after it has made and locked the directory (`supervisor-main.ts:79-80`), sets the file to
mode 0600 as soon as it is bound (the runtime directory keeps every other user out in the instant before; a `umask` around
`listen` is not used because Node refuses to set it in a worker thread, where the behavior scenarios run) and refuses to serve
on a file with any other mode, removes a stale socket first, and removes it at exit. It serves connections only while a
child runs (a connection while none runs is closed unread), at most four at once, one newline-terminated JSON request of at
most 1 KiB per connection, answers once, and closes. The answer is not held to 1 KiB: a session token and a gateway token
together can exceed it, so the child reads up to 16 KiB.
A request that does not parse, or names another dispatch, is answered `no_turn`. Each request is logged
(`owner_credential_socket`: `op`, `outcome`, never a value).

The child:

- Builds `new DynamoDBClient({ credentials: provider })` and `new S3Client({ credentials: provider })` in
  `createContainerOwnerDeps`, with `provider` asking the socket (`SupervisorSocketClient`). The identity it returns has the
  real `expiration`, so the SDK asks again 5 minutes before the end and gets whatever the supervisor holds then.
- Replaces `ModelGatewayConfig.token` with `tokenProvider`. The token is applied **per HTTP request in a `fetch` wrapper**
  (`owner-models.ts` already has one, `timedSender`, that wraps every request but only when a logger is given; the wrapper
  becomes unconditional and sets `Authorization`). It does not rely on the Pi provider calling `resolve` for every request
  (ASSUMPTION A3); `resolve` returns a placeholder.
- Reads no credential from its environment (R10) and never uses the default chain: a guard test greps the child bundle's
  sources for AWS client construction without `credentials` and for the container credentials endpoint and the metadata
  service.
- On `no_turn` or `expired` the provider throws; the request fails, the turn ends with an error (exit code 70, a failure
  that counts toward the limit of three), and the 2a lost-owner recovery settles the turn (9.3 of the 2a contract). It never
  falls back to anything.

### 8.4 A turn longer than an hour

The dispatch carries credentials and a gateway token that end at `expires_at` (one hour). The supervisor keeps them in a
`TurnCredentialLease`, renews them at `expires_at - 1200` with `kind: "turn"` (the dispatch id and turn id it is serving),
and drops the lease when the child exits. The renewal asks the Front Door, which asks the broker with the supervisor token as
authorization; the broker mints the same role with the same five tags for the same turn. The gateway then sees a token it
accepts for the same `turnId`, `ownerId` and `startGeneration` (`model-gateway.ts:331-339`), so its check that this owner
holds the claim is unchanged. A turn can therefore run until the owner drains: at most 28200 seconds, after which the 300
second grace applies as for any drain. **Decided (P1):** the grace stays 300 seconds; a turn cut off at the cap is recovered by the
next owner through the lost-owner recovery of 9.3 of the 2a contract. The alternative of one long credential for the child is rejected in
7.1: it cannot be revoked and would be eight hours of write access to one conversation.

### 8.5 Self-stop and the hard deadline

The supervisor keeps `E`, the end of its credentials (the minimum of the credential expiry and the token expiry as last
received).

| Moment | Supervisor behavior |
| --- | --- |
| `E - 600`, no renewal succeeded | log `owner_credentials_expiring`; enter `draining` as for `drain: true`, with the reason `credentials` (no dispatch accepted, child gets the grace) |
| drain over, or no child | `POST /owner/stop-request` with `reason: credentials` (always approved), then the stop sequence of 8 of the 2a contract: kill stragglers, publish if changed, stopped report, exit 0 |
| `E - 30` and not yet exited | kill the child (SIGKILL), publish nothing more, exit 9, log `owner_stopping reason=credentials_expired`. The heartbeat lapses and the control plane settles the computer (30 seconds) |
| a poll answers `drain: true` for any reason | the same drain; if the server drained first, the stop request is `lifetime` |

Exit code 9 joins the list (`SUPERVISOR_EXIT_CREDENTIALS_EXPIRED`). The 2a constant `CREDENTIAL_STOP_MARGIN_MILLISECONDS`
and `credentialsStopAtMilliseconds` (a single value) are replaced by the lease. The watchdog is unchanged in logic and
changes its two numbers (28500, 28620); the stale-liveness rule is unchanged.

### 8.6 What the supervisor does not do

It does not renew while `stopping` (R21), does not renew a draining owner's own credentials (the server refuses with
`owner_draining`, which ends the attempts), does not keep a lease for a turn whose child exited, and never writes a
credential to a file, a log or its environment.

## 9. State machines

### 9.1 Credentials (the supervisor's, and each turn's)

`remaining` is `E - now`.

| State | Is when | Held | Becomes |
| --- | --- | --- | --- |
| `valid` | `remaining > 1200` | one set | `renewing` at `remaining <= 1200` |
| `renewing` | `remaining <= 1200`, a request in flight or waiting out a pause | the current set, still valid | `valid` on success (new `E`); `expiring` at `remaining <= 600` without success; ended on 401 or a superseding 403 (exit 5); `refused` on 409 `owner_draining` or `owner_stopping` |
| `refused` | the control plane said no for good | the current set | `expiring` (it is a drain) or the owner stops |
| `expiring` | `remaining <= 600` (supervisor) | the current set | `expired` at `remaining <= 30` (hard deadline, exit 9) unless the owner has stopped first |
| `expired` | `remaining <= 0` | nothing usable | the owner is gone; the child's next call fails closed |

For a turn the same states apply; `expiring` there means the child's next storage call may fail and the turn ends as
described in 8.3. A turn's credentials are never "refused" except by `owner_stopping`, because a draining owner is allowed to
finish its turn (6.2 step 3).

### 9.2 The owner's drain reasons

```
                   ownerDrainReason(computer, now)
protocol below minimum ......................... "protocol_version"   (at the first poll)
now - startedAt >= 28200 ....................... "lifetime"
credentialsExpireAt - now <= 600 ............... "credentials"
otherwise ...................................... none
once any holds: no dispatch, no supervisor renewal, stop(lifetime|credentials|unhealthy) approved
```

Owner states and exit codes of the 2a contract (10.1) are unchanged, plus exit code 9.

## 10. Failure handling

| Failure | What happens |
| --- | --- |
| Renewal times out, network error, 5xx, 503 `credentials_unavailable`, a body that does not parse, a kind or expiry that does not match | Counts as a failure. Logged. Retried after 15, 30, 60, 60... seconds. The polls and everything else go on. The credentials in hand stay in use. |
| 429 `renewal_too_soon` | The same, a failure with the same pauses. It happens only after a lost response; the first two pauses (15, 30 seconds) are shorter than the 60 second limit and are refused again, harmlessly; the third succeeds. |
| 409 `owner_draining`, `owner_stopping` | Final. No more attempts. The owner follows the drain or stop it is in. If the supervisor did not yet know of the drain, the next poll tells it. |
| 409 `turn_not_served` (turn kind) | The lease is dropped; the child will fail closed if it still runs. |
| 401, or 403 `stale_generation`, `not_current_owner`, `wrong_organization`, `credential_mismatch` | The owner was replaced or is not the owner: the same as for a poll (`refusalEndsOwnership`): kill the child, publish nothing, exit 5. |
| 422 `invalid_request` | A bug in the supervisor. Logged as a failure, retried; the window ends in the self-stop. |
| Renewals still failing at `E - 600` | Local drain, stop with `credentials`, publish, stopped report, exit 0, all before `E - 180`. |
| The stop sequence hangs | Hard deadline `E - 30`: exit 9. |
| The control plane is unreachable altogether | Polls fail; the fence (25 seconds) ends the owner. Renewal plays no part. |
| A renewal whose response was lost | The server recorded it; the supervisor retries within 60 seconds and gets another set; the lost set is never used and ends within an hour. |

**Clock skew.** Authority is the server's: the drain, the cutoff, the rate limit and the token's expiry check all use the
server clock and the AWS expiration it recorded. The supervisor's clock only schedules (when to ask, when to drain itself,
when to give up), against absolute timestamps in the response. The margins (1200, 600, 30 seconds) are minutes against a
Fargate task whose clock is synchronized by the Amazon time service (ASSUMPTION A10). The first line of defence is that
the server drains an owner on its own clock whether or not the owner's clock agrees; the supervisor's own drain is the
backstop, not the plan.

## 11. How this meets the rest of the system

| Thing | Effect of renewal |
| --- | --- |
| **The live-files fast poll** (`interactiveUntilAt`, 1000 ms) | None. The pace is `min(normal, 1000)` and is computed by the poll; a renewal is a separate request. File requests are answered while a renewal is in flight (scenario). An open Files panel does not keep a computer alive (L-doc), so it does not cause renewals either. While draining, the live predicate still includes `draining`, so a panel reads the live disk until the stopped report, then the snapshot. |
| **Drains** | Three reasons now (6.4). The 300 second grace and 120 second publish are unchanged; the drain begins 600 seconds before the credentials end instead of at a fixed 3000. |
| **The stop veto** | Unchanged for `idle`. `lifetime`, `unhealthy` and `credentials` are never vetoed by pending work or file operations. After any approval, renewals are refused. |
| **The idle clock** | Renewal is not activity (R15). An idle owner stops at 900 seconds, well before a renewal is due. |
| **Overlay seal and clear** | Use the supervisor token; they read it at the time of the request, so a swap between two calls is invisible to them. |
| **Publish and hydrate** | 8.1. |
| **The fence** | A renewal runs concurrently; a renewal failure is not a poll failure and does not count toward the 25 seconds. |
| **Dispatch re-offer** | `chooseDispatch` passes `identity.token`, the token of the request that is being served, to the broker (`owner-supervisor.ts` `grantDispatch`); the old and the new token both verify. |
| **The model gateway** | A turn's gateway token is renewed with its credentials (8.4); without that a turn over an hour fails with 401 `expired` at the gateway even if every AWS call succeeds (F3). |

## 12. Security

### 12.1 Credentials, after 2b

| Credential | Who holds it | What a thief can do | Bound by | Refusal rules |
| --- | --- | --- | --- | --- |
| Supervisor token | supervisor memory | the owner routes of one computer, and **renew itself** while the owner is live, not stopping, not draining, before the cutoff | audience, tenant, computer, owner, generation, start time; 3600 s each | superseded, stopped, replaced: 403; draining, stopping: 409; limit 1/min; expired: 401 |
| Supervisor AWS credentials | supervisor memory | `GetObject`, `PutObject`, `AbortMultipartUpload` on one computer's snapshot prefix (not the overlay: an explicit deny, `supervisor-role-policy.json`); nothing in DynamoDB, Secrets Manager or STS | the role statement; 3600 s each | no renewal without the token |
| Per-turn AWS credentials | supervisor memory; the child over the socket | one conversation's Pi session and items (`owner-role-policy.json`) | five session tags; 3600 s each | renewed only for the dispatched, claimed, active turn |
| Per-turn gateway token | the same | model calls for one turn | tenant, bot, turn, owner; 3600 s each | the gateway's own check that this owner holds the claim |
| The socket | root processes in the container | the active turn's credentials, nothing else | directory mode 0700; socket 0600; one operation | none needed beyond that |
| Broker invoke | the Front Door role | issue for the owner a valid token names, and not past its hard end | Lambda resource policy; authorization re-verified; signed anchor | `invalid_authorization`, `authorization_mismatch`, `owner_lifetime_over` |

### 12.2 Blast radius, one hour against eight

- **A leaked credential alone** (the AWS keys without the token): at most one hour, as in 2a, whatever the owner's age.
  Renewal does not lengthen any single credential, and an attacker cannot extend what the control plane does not issue.
- **A leaked token with its credentials, from supervisor memory:** the holder can renew for as long as the owner stays the
  live owner, not stopping and not draining: up to the hard end, eight hours, where 2a gave one. What the window buys
  is bounded by the owner's own life, not by a clock alone: the legitimate owner stops after 15 idle minutes, a stop ends every
  renewal at once (403 `not_current_owner`), and a newer generation does too (403 `stale_generation`). The credentials already
  issued still work for up to an hour after that, because a role session cannot be revoked for one tenant (7.1). What they open
  has not changed: one computer's snapshot prefix, and, by polling as the owner, per-turn credentials for turns that are
  parked on that computer, one at a time. **Decided (S4):** accepted. The window of a stolen supervisor token is the owner's life, up to 8 hours, mitigated by
  refusing renewal once the owner is superseded or stopped.
- **Why renewal must be refused after a supersede or a stop:** otherwise a replaced or stopped owner, including a zombie
  that came back from a partition, could mint fresh write credentials for a snapshot prefix that a newer owner now holds,
  and corrupt its disk. The route authentication refuses first (`ownerId` and `ownerGeneration` must be the live ones); the
  stopped replay exception is for the state route only; the `owner_stopping` refusal and the conditional record close
  the race with an approved stop. The residual is unchanged from 2a: credentials issued before the stop live until their end.
- **Session-tag integrity.** The broker builds the tags only after the authorization's claims equal the payload, and the
  Front Door builds the payload from the verified token (the path tenant is checked equal to the claims in 5.1 step 3; the
  body's `owner_id` and `generation` are only compared). The trust policy still requires exactly the tags `tenant` and
  `computer` (supervisor) or the five (turn) with the `Null` and `ForAllValues` conditions. Renewal passes no new input to any
  of them. The broker cannot know the current generation; the Front Door's step 5 of 5.1 does, and the broker bounds the rest.
- **Replay of old tokens.** After a renewal the previous token verifies until its own expiry (R19). It is no more powerful than
  the new one. A token of a finished owner fails the `ownerId` check; a bootstrap token is 409; a gateway token is 401 on this
  route (audience). A captured renewal response needs TLS to be captured.
- **An owner on a stale generation** cannot renew: `hostStartGeneration` must equal the token's (5.1 step 5) before any other
  step runs; the broker is not called.
- **What a process running as uid 2000 can and cannot reach.** It cannot list or enter `/run/chatticus` (mode 0700, root),
  so it cannot open the socket (a filesystem socket, never abstract, never TCP); it cannot read `/proc/<pid>/environ` of a
  root process, and no secret is in any `argv` (the child's arguments are the bundle path and `turn`); it cannot signal or
  trace root processes; the supervisor listens on no TCP port. It can still reach the Fargate task metadata endpoint, whose
  task role is empty (unchanged), and loopback ports of other uid-2000 processes. After 2b the child's environment holds no
  credential at all, which removes the one place a read of `/proc` would have mattered. The shell never sees a credential.
  `computer/test_owner_container.sh` gains the checks (scenario "The shell cannot reach...").
- **What a compromised child can do:** read its own turn's credentials over the socket, which it already held. It cannot ask
  for the supervisor's, for another turn's, or for a renewal.
- **The broker widens the Front Door a little more.** The Front Door could already obtain turn credentials for any parked turn;
  it can now obtain supervisor credentials for a computer whose supervisor token it holds. It already held the signing key
  and could mint such a token, so the new bound (the hard end in the signed claim) is a gain, not a loss.
- **Findings of the earlier review:** unchanged by 2b, except finding 3 (secrets in task overrides), which Phase 2a closed
  (the task holds one five-minute, single-use bootstrap token).

### 12.3 Emergency revocation

A role session is revoked for all tenants at once by a deny on `aws:TokenIssueTime` older than a time, attached to the role
through CDK. Because every owner renews, the cost is one failed request for each live owner; it renews and goes on.
**Decided (S6):** this is written as a runbook, [`docs/OWNER_CREDENTIAL_REVOCATION.md`](OWNER_CREDENTIAL_REVOCATION.md), by Part R (section 17): what to do when a
supervisor or a turn credential leaks (revoke the role session with an inline deny carrying an `aws:TokenIssueTime` condition,
through CDK; stop the task; rotate the signing key), in the order to do it, with the cost and the verification of each step.

## 13. Observability

All lines use the existing emitter and carry `tenant_id` and `owner_id`; none carries a token, a key, a credential or a
body. Existing lines are unchanged.

| Line | Where | Fields |
| --- | --- | --- |
| `owner_credentials_refreshed` | supervisor | `kind` (`supervisor` or `turn`), `expires_at`, `attempts`, `duration_ms`, `remaining_seconds_before` |
| `owner_credentials_refresh_failed` | supervisor | `kind`, `status` or `error_name`, `code`, `consecutive_failures`, `remaining_seconds` |
| `owner_credentials_refresh_refused` | supervisor | `kind`, `code` (`owner_draining`, `owner_stopping`, `turn_not_served`) |
| `owner_credentials_expiring` (existing name, new meaning) | supervisor | `remaining_seconds`; written when the local drain begins |
| `owner_draining` | supervisor | `reason` (`lifetime`, `credentials`, `protocol_version`) |
| `owner_stopping` | supervisor | `reason` gains `credentials` and `credentials_expired` |
| `owner_credential_socket` | supervisor | `op`, `outcome` (`ok`, `no_turn`, `expired`, `malformed`), `dispatch_id` |
| `owner_credentials_refresh_ok` | Front Door | `kind`, `expires_at`, `owner_age_seconds` |
| `owner_credentials_refresh_refused` | Front Door | `kind`, `code` |
| `owner_dispatch_withheld` | Front Door | `reason=issuance_cutoff`, once per owner |
| `owner_overdue` | Front Door | `age_seconds`, on every poll of an owner older than 28800 |
| `owner_broker_issued` / `owner_broker_refused` | broker | `purpose` gains `supervisor_renewal`; `duration_seconds`; `code` gains `owner_lifetime_over` |

Questions the lines answer in Logs Insights: how many renewals did each owner make and how long did each take
(`owner_credentials_refreshed` by `owner_id`); how often did an owner stop for credentials (`owner_stopping reason=credentials`);
how old is the oldest live owner (`owner_started` against `owner_stopping`).

Recommended alarms (a CDK metric filter and alarm, with the Part B2 change): any `owner_overdue`; five or more consecutive
`owner_credentials_refresh_failed` for one owner; any `owner_stopping reason=credentials_expired`. None blocks the build.

## 14. Cost

ASSUMPTION A9: on-demand prices as in the 2a contract (C13), not re-verified. One owner hour has 1.5 supervisor renewals and
at most 1.5 renewals for a turn in progress. Each is one Front Door invocation, one broker invocation (256 MB, a few hundred
milliseconds), one STS call (free), two DynamoDB writes and a read. That is well under one thousandth of a cent per owner hour,
against 0.07 to 0.7 cents an hour for polling. Eleven renewals in eight hours. A faulty supervisor in a renewal loop is
limited to 60 renewals an hour by the rate limit. No new resource exists.

## 15. IAM, CDK and the real-IAM guard

**Roles and policies: no change.** `ComputerSupervisorRole` and `ComputerOwnerScopedRole` keep their trust (the broker's
execution role, the exact tag keys with the `Null` and `ForAllValues:StringEquals aws:TagKeys` pair), their permission
documents (`supervisor-role-policy.json`, `owner-role-policy.json`) and `maxSessionDuration` 3600. The broker's own role keeps
`GetSecretValue` on the signing key and `AssumeRole` plus `TagSession` on the two roles, and nothing else. The Front Door keeps
`InvokeFunction` on the broker. A renewal assumes the same role, with the same tags, as the call that created the first
credentials; `DurationSeconds` between 900 and 3600 is inside the role's limit.

**Real-IAM guard** (`docs/ROLE_ACCESS_GUARD.md`; the moto and in-memory stores enforce no IAM, which is the reason this
section exists). The manifest lists data-plane request shapes per role. A renewal adds **no** new shape: the supervisor
makes the same S3 requests with newer credentials, the child the same S3 and DynamoDB requests through a provider instead
of the environment, and the Front Door's new writes are to the computer record, a Messaging-table access the manifest does not
record (ROLE_ACCESS_GUARD.md, "Limits") and which the Front Door already holds. **Rows to add: none.** Rows that must stay
covered by scenarios when the code moves, because the child now builds its clients differently: the existing `ownerTurn` rows
for the Pi sessions, the conversation items and the computer record (the coverage hook records them in the 2b end-to-end
scenarios; a request without a row fails the scenario). The post-deploy `simulate-role-access.ts --environment development`
is run before the image moves (section 18); it shows nothing new, and a difference is a defect.

What is not covered by the guard and is covered by the live proof instead: the trust policy and tag conditions on the
broker's `AssumeRole` for a renewal (the manifest simulates data-plane actions; the proof reads CloudTrail), and the
behavior of S3 when a multipart upload spans two sessions (A5).

**CDK tests** (`infra/test/computer-owner-stack.test.ts`): assert the broker role has no permission beyond the secret and the
two role ARNs (no DynamoDB, no S3, no SQS); both roles' trust and `maxSessionDuration` are unchanged; the development fault
switch (R22) sets the broker environment in development and fails synthesis for staging and production (gates G1 and G2),
and the staging and production templates hold neither fault variable and do hold `CHATTICUS_ENVIRONMENT` on the broker.

**Structural test** (`conversation/test/broker-fault-gate.test.ts`, vitest: a structure guard, not behavior): the two fault
variable names appear in no file under `conversation/src` or `infra/lib` except the fault module and the stack's development
branch; the broker handler imports the fault module and nothing else reads the variables; and initializing the fault module with
each of `production`, `staging`, an empty and a missing `CHATTICUS_ENVIRONMENT` and a fault variable set throws (gate G3), while
the same with `development` does not. The scenario "The broker refuses to start with a fault switch outside development"
pins the same behavior through the deployed entry point.

## 16. Traceability

Scenario names are those of `features/computer_owner_credential_renewal.feature`. Tags: `@server`, `@broker`,
`@supervisor`, `@child`, `@image`, `@infra`, `@end-to-end`.

| Requirement | Scenarios | Tag |
| --- | --- | --- |
| CR1. One call returns new supervisor credentials and a new token for the same owner, role and tags (R1, R2, R7) | The owner renews its supervisor credentials and keeps its generation; The broker renews supervisor credentials with the role and tags of the bootstrap | server, broker |
| CR2. A renewal needs a good token for this owner (6.1, 6.2 step 1) | A renewal that is not good is refused; A renewal that names another owner than its token is refused | server |
| CR3. Not after a stop or a supersede (R6, 12.2) | A renewal is refused after the computer stopped; The credentials route is not part of the stopped report replay; A renewal is refused once a stop was approved; An owner that was replaced cannot renew and ends | server, end-to-end |
| CR4. Not while draining (R6) | A renewal is refused once the control plane drains the owner | server |
| CR5. Nothing outlives the hard end (R5, R8) | No dispatch is offered in the last 900 seconds of the hard lifetime; No renewal is granted in the last 900 seconds of the hard lifetime; No credential the broker issues outlives the hard lifetime; The broker refuses what it should not renew; A supervisor token issued at bootstrap names the moment the owner started | server, broker |
| CR6. One renewal a minute per kind (R9) | Renewals are limited to one a minute for each kind; Turn credentials and supervisor credentials are limited separately; A new dispatch starts the turn credential limit over | server |
| CR7. A broker failure changes nothing (6.2 step 5) | A renewal the broker cannot serve changes nothing and may be asked again at once; A renewal reports an STS failure by name only | server, broker |
| CR8. A renewal that loses to a stop is discarded (6.2 step 6) | A renewal that lost the race with an approved stop is discarded unseen | server |
| CR9. The drain follows the issued credentials (R4) | The control plane drains an owner that does not renew when its credentials are ten minutes from the end; An owner that renews is not drained at fifty minutes and is drained at seven hours and fifty; A stop for the drain is approved whatever the drain was for | server |
| CR10. A stop for credentials is always approved (R14) | A stop for credentials the owner could not renew is approved whatever is pending | server |
| CR11. Protocol version drain (R17) | An owner below the minimum protocol version is told to drain and is offered nothing | server |
| CR12. A turn's credentials are renewed for the turn the owner serves (R2, R11) | The owner renews the credentials of the turn it serves; Turn credentials are refused for a turn the owner is not serving; Turn credentials are renewed while the owner drains but not after a stop is approved | server |
| CR13. The owner routes stay closed to the invoke key (5.1) | The credentials route cannot be opened with the invoke key alone | server |
| CR14. A renewal is not work (R15) | A renewal does not count as work; A renewal does not start the supervisor's idle clock over | server, supervisor |
| CR15. An overdue owner is reported (R16) | An owner far past its lifetime is reported | server |
| CR16. The supervisor renews on time and swaps atomically (R3, R13) | The supervisor renews its credentials twenty minutes before they expire; The token and the credentials are swapped in one step; A publish in flight when the credentials are swapped finishes and the next request uses the new ones | supervisor |
| CR17. The polls and the file requests go on during a renewal (R3, F12) | The supervisor keeps polling while a renewal is in flight; A live file request is answered while a renewal is in flight | supervisor |
| CR18. Failure handling (section 10) | A renewal that fails is repeated with growing pauses until it succeeds; A renewal the control plane refuses for good is not repeated; A renewal that says the owner is not the owner ends it | supervisor |
| CR19. Self-stop and hard deadline (R14) | An owner whose renewals keep failing drains ten minutes before its credentials expire and stops before they do; An owner that cannot finish its stop before the credentials end exits at the hard deadline; The supervisor renews nothing once it is stopping | supervisor |
| CR20. The turn's credentials are the supervisor's to renew and the child's to read (R10, R11, R12) | The supervisor renews the credentials of the turn it serves and keeps them in memory; A turn credential renewal that fails is repeated until it succeeds or the child ends; A turn that is not the one being served gets nothing over the socket; A child reads its credentials from the supervisor and holds none in its environment | supervisor, child |
| CR21. A long turn finishes; a failing renewal fails closed (R11, F3) | A turn that runs past the first hour keeps working; A child whose credentials could not be renewed fails closed; The model gateway token is read for each request | child |
| CR22. The child builds no AWS client without a provider (F2) | The child holds no AWS client without explicit credentials | child |
| CR23. The shell reaches nothing (R12, 12.2) | The shell cannot reach the supervisor's socket or the credentials | image |
| CR24. No secret in a log (13) | The supervisor logs about credentials carry no token, key or credential | supervisor |
| CR25. The watchdog is sized for eight hours (R5) | The watchdog is sized for eight hours | supervisor |
| CR26. An owner survives a renewal, a turn survives an hour, an owner ends at the cap (R1 to R6) | An owner keeps serving across a credential renewal; A turn longer than an hour finishes; An owner at its eight hour limit drains, stops, and the next message starts a new owner | end-to-end |
| CR27. Nothing in IAM changes (R18) | Renewal adds no permission to the broker and no role changes its trust or session limit | infra |
| CR28. The fault switch exists in development only; production cannot enable it (R22, P4, gates G1 to G4) | The broker's development fault switch exists in development only; The staging and production brokers hold no fault variable and know their environment; The broker refuses to start with a fault switch outside development; The development fault switch denies a renewal and shortens the credentials; plus the structural test `broker-fault-gate.test.ts` (vitest, section 15) | infra, broker |
| CR29. The broker refuses a token without the signed start time (R8, S2) | A turn is refused for a supervisor token without a start time; The broker refuses what it should not renew (row: no start time) | broker |

Scenarios of the design document's Phase 2 list that this closes: "refresh extends credentials and is refused for a stale
generation or a stopped computer" (CR1 to CR3), "old protocol drains" (CR11).

## 17. Work assignment

Nine parts (eight of code, one runbook), each a pull request into `develop` with Gherkin first (`AGENTS.md`): the scenarios a part owns move from the
draft feature into `features/cucumber-features.txt` together with their steps, in the same pull request. Each part lists the
files it changes. Do not read or write `project/`. The Kanbus sub-tasks of `chatticus-3a31bb` carry the same text:

| Part | Kanbus | Blocked by |
| --- | --- | --- |
| P0 Foundation | `chatticus-881c41` | none |
| A1 Server, derived drain and lifetime | `chatticus-9adfdf` | P0 |
| A2 Server, the credentials route | `chatticus-726d46` | P0, A1 |
| B1 Broker | `chatticus-76131c` | P0 |
| B2 Infrastructure and the fault switch | `chatticus-4f3fcc` | P0, B1 |
| C Supervisor | `chatticus-bab38c` | P0 |
| D Child and socket | `chatticus-d1211a` | P0 |
| E Integration, deploy, live proof | `chatticus-7835bb` | A1, A2, B1, B2, C, D |
| R Emergency revocation runbook | `chatticus-816a1a` | none |

### P0. Foundation (first; small; merged before any other part)

Shared contracts only, so that A1, A2, B1, C and D can be built in parallel against them. **Its merge deploys the strict claim:
see section 18 step 1.**

- `host-protocol/src/supervisor.ts`: every **new** constant of section 4 (no value changes yet), the schemas of section 5
  (claim `ownerStartedAtSeconds`, the credentials route, the broker purpose and error code, the four error codes and the 429
  status, the stop reason `credentials`, the socket schemas), the child environment list changes. `OWNER_PROTOCOL_VERSION`,
  `OWNER_MAX_LIFETIME_SECONDS` and the derived watchdog constants keep their values until A1 and C.
- `conversation/test/owner-supervisor-protocol-schema.test.ts`: a test of every new schema, the claim's strictness, the
  constants' arithmetic (600, 27900, 28200 when A1 lands).
- Every place that mints a supervisor token supplies the claim: `conversation/src/lambdas/owner-credential-broker.ts`
  (bootstrap sets `ownerStartedAtSeconds` to its own `nowSeconds`; renewal and clamp wait for B1),
  `conversation/features-support/fakes/fake-owner-credential-broker.ts`, the steps that mint tokens
  (`owner-host-token.steps.ts` and the others the compiler finds), `conversation/test/session-token.test.ts`,
  `supervisor-session-token.test.ts`, `fake-owner-credential-broker.test.ts`, `lambda-owner-credential-broker.test.ts`.
- `conversation/src/computer/owner-credential-broker.ts`: the `supervisor_renewal` overload and its grant type.
- `FakeOwnerCredentialBroker`: handles `supervisor_renewal`, enforces the hard end, records requests, can hold and release an
  answer, can be told to fail.
- `computer/host/src/supervisor-ports.ts`: the `SupervisorPlane.renewCredentials` method and the `TurnCredentialSource`
  interface (`current(dispatchId): { aws_credentials, gateway_token, expires_at } | null`) that D's socket server reads and
  C's lease implements; `conversation/features-support/fakes/fake-supervisor-plane.ts` implements `renewCredentials`
  (scriptable answers, delays and failures, a record of every request).
- Acceptance: `cd conversation && npm run typecheck && npm test && npm run test:features` green with no scenario of the draft
  feature registered; `cd infra && npm test`.

### A1. Server: the drain is derived from the issued credentials (depends on P0)

Behavior-preserving for an image that does not renew; the first part that changes a live number.

- `host-protocol/src/supervisor.ts`: `OWNER_MAX_LIFETIME_SECONDS` to 28200 (the formula), the derived watchdog constants.
- `computer/chatticus-watchdog`: `terminate_after=28500`, `kill_after=28620`; the header comment.
- `conversation/test/computer-image-structure.test.ts`, `conversation/features-support/steps/owner-watchdog.steps.ts`:
  the numbers; `features/computer_owner_supervisor.feature` scenario "The watchdog asks, then forces, at the end of the
  lifetime" and the new "The watchdog is sized for eight hours" (owned by A1 because it must change with the constants).
- `conversation/src/store/codecs/computer.ts`, `store/messaging-store.ts`, `store/dynamo-messaging-store.ts`,
  `features-support/in-memory-messaging-store.ts`: `ownerCredentialsExpireAt`; `consumeOwnerBootstrap` stores it; cleared with
  `ownerId`. Contract test in `conversation/test/dynamo-messaging-store.contract.test.ts`.
- `conversation/src/domain/owner-supervisor.ts`: `ownerDrainReason`, `ownerIssuanceClosed`; the poll, the dispatch gate, the stop
  predicate (`lifetime` approved for any drain reason; `credentials` always approved), `owner_overdue`, the `minimumProtocolVersion`
  dependency; `exchangeOwnerBootstrap` passes the grant's expiry.
- Existing scenarios whose steps set `ownerStartedAt` also set `ownerCredentialsExpireAt`
  (`features/owner_supervisor_server.feature` lines 261, 269; `features/computer_owner_long_lived.feature` line 91).
- Steps: `conversation/features-support/steps/owner-supervisor-server.steps.ts` (the clock, "whose credentials were renewed
  until", "requires protocol version").
- Scenarios owned: the `@server` scenarios of CR5 ("No dispatch is offered in the last 900 seconds of the hard lifetime"), CR9,
  CR10, CR11, CR15; `@supervisor` "The watchdog is sized for eight hours" (CR25).
- Acceptance: typecheck, vitest, `test:features`; with the old image the observable drain moment is unchanged (3000 seconds).

### A2. Server: the credentials route (depends on P0, A1)

- `conversation/src/http/owner-host-auth.ts` (`OWNER_COMPUTER_ROUTES`), `conversation/src/http/owner-supervisor.ts`
  (`ownerCredentialsHandler`), `conversation/src/http/app.ts` (`declareRoute`, audience `computer-owner`), 422 and 429 bodies
  with `code`.
- `conversation/src/domain/owner-supervisor.ts`: `renewOwnerCredentials` (6.2), for both kinds.
- Store: `renewOwnerCredentials` (conditional update, in the in-memory store and DynamoDB), the two fields, `offerOwnerDispatch`
  resets `dispatchCredentialsRenewedAt`; contract tests.
- `conversation/src/computer/owner-credential-broker.ts`: the Lambda adapter handles `supervisor_renewal`.
- `conversation/test/route-audience.test.ts`.
- Scenarios owned: all other `@server` scenarios: CR1 to CR4, CR5 ("No renewal is granted..."), CR6, CR7, CR8, CR12, CR13, CR14
  (server side). Steps in `owner-supervisor-server.steps.ts` (shared with A1; whoever merges second rebases).
- Acceptance: as A1; the coverage hook shows no unlisted request.

### B1. Broker (depends on P0)

- `conversation/src/lambdas/owner-credential-broker.ts`: `supervisor_renewal` (7), the anchor, the hard end, `owner_lifetime_over`,
  `DurationSeconds` and the token expiry cut to the hard end for `supervisor_renewal` and `turn`, stable session names.
- `conversation/test/owner-credential-broker.test.ts`, `lambda-owner-credential-broker.test.ts`, and the steps
  `conversation/features-support/steps/owner-credential-broker.steps.ts` of `features/owner_credential_broker.feature` extended
  (the existing scenarios of that file keep their meaning; the claim is added to their answers).
- The broker requires the signed start time (decided S2): a token without `ownerStartedAtSeconds` fails the strict claims schema
  and is `invalid_authorization`, for every purpose.
- Scenarios owned: all `@broker` scenarios except the three about the development fault switch (B2's).
- Acceptance: typecheck, vitest, `test:features`; the broker's log lines carry no token.

### B2. Infrastructure (depends on P0; the fault switch part depends on B1, the same file)

- `infra/test/computer-owner-stack.test.ts`: the assertions of section 15 (can merge before B1).
- The development fault switch (R22, decided P4), with its four gates: `infra/lib/control-plane-stack.ts` reads the CDK context
  (`ownerBrokerFault`: `none`, `deny_supervisor_renewal`, `deny_turn_renewal`; `ownerBrokerCredentialSeconds`: 900 to 3600) only
  when the environment is `development`, throws naming the switch for staging or production (G1), emits the two broker
  variables only in development and always sets `CHATTICUS_ENVIRONMENT` on the broker (G2).
  `conversation/src/lambdas/owner-credential-broker-faults.ts` (new; the only reader of the variables) throws at initialization
  if a variable is set and `CHATTICUS_ENVIRONMENT` is not `development` (G3); `owner-credential-broker.ts` takes a `faults`
  dependency (default none) and applies it: a denied purpose answers `assume_role_failed`, a shorter duration replaces 3600,
  never longer and never below 900 (G4). The broker edit is made after B1 merges.
- `conversation/test/broker-fault-gate.test.ts`: the structural test of section 15.
- The metric filters and alarms of section 13 (optional in the same PR).
- Scenarios owned: both `@infra` scenarios and the `@broker` scenario "The broker refuses to start with a fault switch outside
  development".
- Acceptance: `cd infra && npm test`; `cd conversation && npm test && npm run test:features`; `npx cdk synth` with and without
  the context in development, and with it for staging and production (fails, naming the switch).

### R. Emergency revocation runbook (no code; independent of every other part)

Decided S6. Contract: this page, 12.3 and 7.1.

- `docs/OWNER_CREDENTIAL_REVOCATION.md` (new): what to do when a supervisor credential or a per-turn credential leaks, in order,
  each step with its cost, who may do it and how to verify it: (1) stop the task (`aws ecs stop-task`; the owner reports stopped,
  the control plane then refuses its token because the owner is no longer the live owner); (2) revoke the role session with an
  inline deny on `ComputerSupervisorRole` and `ComputerOwnerScopedRole` carrying an `aws:TokenIssueTime` condition (a CDK
  change deployed by the normal path, never by hand in the console; it affects every tenant's sessions of that role, and live
  owners recover at their next renewal because a new session has a later issue time); (3) rotate the signing key secret (it
  invalidates every supervisor, bootstrap and gateway token at once; owners then exit 5 and publish nothing, so it is the last
  resort and the document says what unpublished work is lost); (4) after the incident, remove the deny, and check CloudTrail
  `AssumeRole` events and the `owner_credentials_refreshed` lines to bound what was reachable. It cites the blast-radius analysis of
  12.2 and holds no account id (those live in `AGENTS.local.md`).
- A link from `docs/THREAT_MODEL.md` and from this page's 12.3.
- Acceptance: the document exists, every command in it was run read-only or in a dry run on development where that is possible
  (the CDK deny is synthesized, not deployed), and a second reader followed it once. Kanbus comment with the result.

### C. Supervisor (depends on P0; integrates with A2 and B1 in E)

- `computer/host/src/supervisor.ts`: leases, the renewal activity, the swap, the local drain at `E - 600`, the hard deadline
  and exit 9, no renewal while stopping, stop reason `credentials`; `OWNER_PROTOCOL_VERSION` to 3 (in
  `host-protocol/src/supervisor.ts`). `computer/host/src/supervisor-ports.ts`: `SUPERVISOR_EXIT_CREDENTIALS_EXPIRED = 9`.
- `computer/host/src/protocol-client.ts` (`renewCredentials`, `replaceBearerToken`), `supervisor-main.ts` (the S3 client with a
  provider; `openDisk` signature), `host-disk-lifecycle.ts` if it holds credentials.
- A `CredentialHolder` and `CredentialLease` module (new, `computer/host/src/credential-lease.ts`) with a vitest unit test of
  the schedule and the swap.
- `conversation/test/owner-supervisor-client.test.ts` (the client's new method and token replacement).
- The fake plane (`fake-supervisor-plane.ts`, from P0), the fake spawner (`fake-child-spawner.ts`: a fake child already runs
  until told) and a storage fake that records the credentials of each request (`fake-supervisor-disk.ts`), in
  `conversation/features-support/fakes/`; the steps are in `conversation/features-support/steps/owner-supervisor-renewal.steps.ts`.
- Scenarios owned: the `@supervisor` scenarios of CR14 (supervisor side), CR16 to CR20, CR24 (not the watchdog scenario, A1's).
  They live in `features/computer_owner_credential_renewal_supervisor.feature`, registered in `features/cucumber-features.txt`;
  the draft keeps only the socket scenario of D. A scenario that runs past fifteen idle minutes has the control plane veto the
  idle stop, as it does while work is pending, and the scenario "An owner stops before the credentials it holds expire" of
  `computer_owner_supervisor.feature` now has the renewals fail, stops with the reason `credentials` at 3000 seconds.
- Acceptance: `computer_owner_supervisor.feature` stays green; typecheck; vitest; the supervisor bundle imports nothing
  forbidden by `computer-image-structure.test.ts`.

### D. Child and socket (depends on P0; integrates with C in E)

- `computer/host/src/supervisor-socket.ts` (new): the server (listen under umask 0o177, stale socket removal, limits, schema,
  `no_turn`, logs) against the `TurnCredentialSource` of P0; `supervisor-main.ts` creates it.
- `computer/host/src/supervisor-child-environment.ts`: no credentials, adds the socket path; its vitest.
- `computer/host/src/owner-deps.ts`, `owner-models.ts`, `owner-main.ts`: providers, `SupervisorSocketClient`, the `fetch` wrapper
  that sets `Authorization`, the failure path.
- `conversation/test/container-owner-config.test.ts`, `owner-session-env.test.ts`: updated for the missing environment.
- `conversation/test/computer-image-structure.test.ts`: the guard of 8.3 (no AWS client without `credentials`, no metadata
  endpoints) over the child's sources.
- `computer/test_owner_container.sh`: the shell cannot list `/run/chatticus`, open the socket, or read the environment of the
  supervisor or the child.
- Scenarios owned: `@child` and `@image`; the socket scenarios of CR20.
- Acceptance: as C; `computer/test_owner_container.sh` passes against a built image.

### E. Integration, deploy and live proof (depends on A1, A2, B1, C, D; B2 for the failure proof)

- The four `@end-to-end` scenarios in one steps file, with the real routes, the real supervisor and a fake clock.
- `conversation/bin/acceptance.ts` (and `conversation/src/acceptance/`): a `--owner-soak <minutes>` mode (section 19).
- The deploy and the live proof of sections 18 and 19, each result recorded in a Kanbus comment.
- The milestone sub-agent required by `AGENTS.md`: Kanbus statuses, the README "What is live today", this page's Status block
  becomes "BUILT", the draft feature file's header is removed as its scenarios are registered.
- Acceptance: all of the above, and `docs/LONG_LIVED_COMPUTER.md` Phase 2b marked live.

### Order and dependencies

```
P0 --+--> A1 --> A2 ----------+
     +--> B1 --> B2 (switch) -+--> E
     +--> B2 (assertions) ----+
     +--> C -----------------+
     +--> D -----------------+
```

1. This contract merges. 2. P0 merges (one pull request, reviewed first). 3. A1, B1, B2 (assertions), C, D in parallel; A2
after A1; B2's fault switch after B1. 4. E last. C and D need only the fakes of P0; the integration is E's. Part R has no
dependency and no dependent: any time.

## 18. Deploy order

The Computers stack (the owner task definition) is not touched. Merging to `develop` deploys the ControlPlane and ThinTurn
stacks from CI and builds the image as `sha-<commit>` without moving the tag the task definition reads
(`docs/COMPUTER_IMAGE_PROMOTION.md`). The image moves only by the separate promotion workflow, after the server side of the
same commit is verified. Development only; there is no compatibility path.

1. **Before P0 merges: no owner task is running** (`aws ecs list-tasks` on the Computers cluster, from a logged-in shell).
   P0's broker puts the new claim in every supervisor token it issues, and the strict claims schema refuses a token of the
   previous format: a running owner would get 401 on its next poll, exit 5 and publish nothing. This is the same precondition
   as Phase 2a.
2. P0, then A1 and B1 (ControlPlane and ThinTurn deploy from CI). The old image (Phase 2a) still runs: it bootstraps, polls, is
   dispatched and drains at about 3000 seconds, because the server derives the drain from the credentials it issued (R4). Verify with one
   message to a development computer: `owner_started`, `owner_bootstrapped`, `owner_serving_turn`, `owner_child_exited
   clean=true`.
3. A2 and B2. The route is covered in CI by the scenarios on the real routes (a live owner of the old image never calls it, so
   nothing on development exercises it until the image moves). Check the deploys succeeded and that the Front Door log shows no
   `owner_*` error.
4. C and D merge (the image builds as `sha-<commit>`, nothing changes in the running system).
5. Run `npx tsx conversation/bin/simulate-role-access.ts --environment development` (read-only). It must show every manifest
   row allowed and nothing new (section 15).
6. Run **Promote computer image (development)** with the full commit sha of C and D. The workflow itself refuses unless the
   ControlPlane and ThinTurn runs for that commit succeeded.
7. The live proof (section 19).
8. **Only after step 7 has passed,** and the new image has run in the field, an operator may raise
   `OWNER_MINIMUM_PROTOCOL_VERSION` to 3 in a separate change (decided P3). Until then it stays 1. Done: section 19.1.
9. **Rolling back:** the image first (`COMPUTER_IMAGE_PROMOTION.md`, "Rolling back"). The server stays: it serves an old image
   unchanged. **Never roll the server back below the promoted image**: a supervisor of this phase against a server without the
   route retries a missing route for 10 minutes, drains itself, and its `credentials` stop reason is a 422 to the older server.

What breaks between the steps, and only on development: nothing, by construction, other than step 1's precondition. A new
image against an old server, and an old image against a new server, are both avoided by the order; the second is also safe.

## 19. Live proof

Requirement: an owner survives past 50 minutes and past one hour of credentials, a turn survives past one hour of its
credentials, a failed renewal ends the owner cleanly, a refused renewal after a stop is observed. Idle computers stop after
900 seconds and run one turn at a time (F13), so each proof states how the owner is kept busy.

**Evidence sources.** The owner's log stream (`awslogs`, prefix `computer-owner`), the Front Door log group, CloudTrail
`LookupEvents` (`EventName=AssumeRole`, role names `ComputerSupervisorRole` and `ComputerOwnerScopedRole`), and `GET /computer`
for the record. Run from a logged-in shell; the commands use `AWS_PROFILE` as in `AGENTS.local.md`.

1. **Renewal across one hour, with short turns (75 minutes).** The acceptance runner mode of Part E,
   `npm run acceptance -- --environment development --owner-soak 75`, creates a bot and a channel, and every 8 minutes sends a
   message whose only job is "append the current time to /workspace/soak.log with a shell command". Eight minutes is under
   the idle timeout (15), and a turn takes seconds, so the owner is idle and polling between turns. Check:
   - exactly one `owner_started`, and `owner_bootstrapped`, for the whole run;
   - `owner_credentials_refreshed kind=supervisor` at about 40 minutes (+/- 1) and again at about 80 minutes if the run is extended
     to 85 minutes (extend it once as a final confirmation); `remaining_seconds_before` about 1200;
   - the turns sent at minutes 64 and 72 are served (`owner_child_exited clean=true`): the poll that offered them was accepted
     only because the supervisor presented its renewed token (the first one ended at 60 minutes), and the dispatch credentials
     they ran with were issued by a broker call authorized by that token. (No `kind=turn` renewal is expected here: turns
     are short. That is step 2.)
   - a `snapshot_published` after minute 61 (the quiet publish after the last turn): it can only succeed with the renewed
     supervisor credentials; the published checksum in `GET /computer` changes;
   - CloudTrail: `AssumeRole` of `ComputerSupervisorRole` at 0, about 40 and, in the extended run, about 80 minutes, every one by the
     broker role, tags `tenant` and `computer`, `RoleSessionName` `supervisor-<ownerId>` all three times;
   - after the run, stop sending; at 15 idle minutes `owner_stopping reason=idle` and the stopped report (the idle clock
     was not touched by the renewals); the next message starts a new owner that hydrates `soak.log` with every line.
2. **A turn longer than the first hour of its credentials (about 70 minutes).** The same mode with `--long-turn`: one message
   asking the bot to run `sleep 590` seven times in separate terminal calls and then write `done` to `/workspace/long.log`
   (each tool call ends inside its own 600 second limit). The child is busy for about 69 minutes, so the owner is never idle.
   Check `owner_credentials_refreshed kind=turn` at about 40 minutes after the dispatch, the tool calls after minute 60
   succeed, the Pi session commit objects written after minute 60 exist, and `owner_child_exited clean=true`. ASSUMPTION: a
   model that is asked for seven sleeps does them; if it does not, repeat. A computer runs one turn at a time, so run steps 1
   and 2 one after the other, or in two organizations at once if the acceptance runner can create a second one.
3. **The same proofs in 15 minutes, with the development fault switch (Part B2).** Deploy the development ControlPlane with
   `ownerBrokerCredentialSeconds=900`. Supervisor credentials then last 900 seconds, below the 1200 second margin, so the
   supervisor renews every 60 seconds (the rate limit): in a 20 minute run the original credentials expire at 15 minutes, a
   publish after that works, and `owner_credentials_refreshed` appears about 20 times. This proves the swap across a real
   expiry. Restore the deploy afterwards.
4. **Failure of renewal.** Deploy with `ownerBrokerFault=deny_supervisor_renewal` and `ownerBrokerCredentialSeconds=900`: the
   owner bootstraps with 900 second credentials, every renewal is a 503, so `owner_credentials_refresh_failed` repeats at 15,
   30, 60 seconds; at 300 seconds after the bootstrap (600 seconds before the 900 second credentials end)
   `owner_draining reason=credentials` and `owner_credentials_expiring`; with a turn running,
   `owner_child_exited` at about 600 seconds after the bootstrap (the 300 second grace); `owner_stop_requested reason=credentials`, `owner_stop_decision approved=true`,
   `snapshot_published` if changed, `owner_stopping reason=credentials`, the task STOPPED, the record stopped with no owner,
   the container exit code 0, and the owner gone before 900 seconds. A message sent during the drain parks, and the stopped report starts the next
   owner. Restore the deploy afterwards.
5. **Nothing is renewed after a stop.** Send `ecs stop-task` to an owner at 41 minutes into step 1 (inside its renewal window):
   `owner_stopping reason=sigterm`, the stopped report, and, in the broker's log group, no `owner_broker_issued
   purpose=supervisor_renewal` for that owner id after the stop. (The refusal itself, 403 `not_current_owner` and 409
   `owner_stopping`, is proved by the scenarios; a live owner's token is never extracted.)
6. **At the end of the 8 hours** the owner is not run for eight hours live; the 8-hour behavior is proved by the end-to-end
   scenario (fake clock) and, live, by step 1 extended past 85 minutes. This is a stated limitation. The 8 hours are measured from the bootstrap (decided P2).

**Cost of the proof.** Steps 1 and 2 cost model calls for a few dozen small turns and one computer-hour each. Steps 3 and 4
need two ControlPlane deploys.

### 19.1 Live proof results (development)

Both proofs were run on the development environment against the image that renews.

**Success path, 81 minutes.** One owner, one task, no self-stop. The supervisor renewed its credentials at minute 40 and again
at minute 80, each time with about 1200 seconds remaining (the renewal margin), as in step 1.

**Failure path, with the development broker fault** (`deny_supervisor_renewal`, 900 second credentials). The broker answered
every renewal 503 `credentials_unavailable`. The retry pauses were 15, 30 and then 60 seconds. The owner drained when 600
seconds of its credentials remained (`owner_draining reason=credentials`), asked to stop with the reason `credentials`, and
`owner_stopping reason=credentials` followed about five minutes after the bootstrap. The next message started a fresh owner.

**What the code says, and where the observations need a reason**

- *The drain begins at expiry minus 600 seconds.* `OWNER_CREDENTIAL_DRAIN_BUDGET_SECONDS` is the drain grace (300) plus the final
  publish budget (120) plus the lifetime margin (180), which is 600. `CredentialLease.localDrainAtMilliseconds()` returns the
  expiry minus that budget, and the supervisor begins its own drain from it (`beginCredentialDrainWhenExpiring`) without
  waiting for the control plane. With 900 second credentials that is 300 seconds after the bootstrap. The hard deadline is the
  expiry minus 30 seconds.
- *The first failed renewal comes about 60 seconds after the bootstrap when credentials last 900 seconds.* The 1200 second
  renew-ahead window is longer than the 900 second lifetime, so renewing is already due at the bootstrap. What delays it is the
  minimum interval: `CredentialLease.dueAtMilliseconds()` takes the latest of the window start, the last success plus
  `OWNER_CREDENTIAL_RENEWAL_MINIMUM_INTERVAL_SECONDS` (60), and, after a failure, the retry pause. The bootstrap counts as the
  first success, so the first attempt is at 60 seconds. Later attempts follow the 15, 30, 60, 60... pauses because the 60
  second floor has already passed.
- *Exit codes by cause* (`computer/host/src/supervisor-ports.ts`): 0 for a stop the control plane approved, whatever its reason
  (`idle`, `lifetime`, `credentials`, `unhealthy`); 143 for SIGTERM; 9 (`SUPERVISOR_EXIT_CREDENTIALS_EXPIRED`) when the hard
  deadline cut a stop short, logged as `owner_stopping reason=credentials_expired`; 5 when the owner learned it is no longer the
  owner (`owner_stopping reason=superseded`); 4 when the control plane fell silent (`fenced`); 6 bootstrap failed; 7 wrong
  settings; 8 the disk could not be restored.
- *The container exit code 5 and the second `owner_stopping reason=superseded` line 0.3 seconds after `reason=credentials` were
  a bug, not the design.* While the approved stop was running, the supervisor kept polling. A poll the control plane answered
  with an ownership refusal (403 `not_current_owner`) made the poll failure handler end the owner as superseded: a second
  `owner_stopping` line and, because that came before the stopped report returned, exit code 5 instead of 0. The scenario
  "A poll refused while the owner is stopping does not turn an approved stop into superseded" in
  `features/computer_owner_supervisor.feature` reproduces exactly that log and exit code and now passes. A poll refused while
  the owner is stopping changes nothing; the stopped report decides, and a refused stopped report still ends the owner as
  superseded. A credentials stop exits 0 from this change on.
- *The minimum protocol version is 3.* The live owner record reports `owner_protocol_version` 3, the version that renews
  (`OWNER_PROTOCOL_VERSION` in `host-protocol/src/supervisor.ts`, announced in the bootstrap and every poll, and imported by both
  the supervisor and the control plane). An owner that announced a lower version is not refused at the bootstrap; its next poll
  is answered with `drain_reason: "protocol_version"` and no dispatch. The development image tag already runs the new image;
  the staging and production images must be built from this code before this change reaches `main`, or their owners drain
  on every poll.

## 20. Decisions taken

**Assumptions** (marked where they appear):

- A1. A Lambda execution role's `AssumeRole` is not role chaining. Not needed (7.1).
- A2. The SDK re-reads a provider's credentials only inside the last 5 minutes before their expiration. Read from the
  installed `@smithy/core` (`memoizeIdentityProvider`, `EXPIRATION_MS = 300_000`); P0 pins the check in a vitest test
  against the installed version.
- A3. Pi calls `resolve` for every model request. Not relied on: the gateway token is set by the `fetch` wrapper.
- A4. S3 authorizes a request when it starts, so a single `GetObject` or `PutObject` begun before the credentials end finishes
  after they end. If not, the failure is a logged publish failure retried at the next trigger. The publish cadence makes
  this irrelevant while renewals succeed.
- A5. A multipart upload begun with one session of a role may be continued with another session of the same role and the same
  session name. If S3 refuses, the publish fails once and is retried from the start.
- A6. Fargate keeps `/run` writable and supports a filesystem Unix socket (the directory already exists and is written).
- A7. `/proc/<pid>/environ` and `/run/chatticus` are unreadable to uid 2000 (the existing container test proves the first).
- A8. STS accepts `DurationSeconds` from 900 to 3600 for these roles.
- A9. Prices (section 14).
- A10. The task clock is synchronized by the platform.

**Decisions of the owner.** The owner took the recommendations on the questions this page first left open. Each is applied where it matters; the third
column says where.

| # | Decision | Applied in |
| --- | --- | --- |
| P1 | **No longer grace.** The drain grace stays 300 seconds. A turn cut off at the cap is recovered by the next owner (lost-owner recovery, 9.3 of the 2a contract). | 4, 8.4 |
| P2 | **Yes: the 8 hours are measured from the bootstrap**, not from the last activity. A computer busy all day is replaced every 7 hours 50 minutes with one cold start of about 30 seconds. | 1, 4, 19 |
| P3 | `OWNER_MINIMUM_PROTOCOL_VERSION` is raised (to 3) **only after the new image is promoted and proven live**; until then it stayed 1 (it is 3 now, section 19.1). The drain mechanism lands in the rollout; raising the minimum is a later operator change, never a rollout step. | 1.2, R17, 6.5, 18 |
| P4 | **Yes: the development-only fault switch is built,** gated off in production at build time and at runtime by the four gates of R22, with a scenario and a structural test that production cannot enable it. | R22, 15, 17 B2, 19 |
| P5 | **No external `ecs:StopTask` watchdog.** The in-container watchdog (2a), the drain, the idle timer and the `owner_overdue` alarm are the bound. | R16, 13 |
| S1 | **The broker stays store-free.** The Front Door reads the computer record and refuses before it invokes the broker. | R7, 6.2, 7 |
| S2 | **The broker requires the signed start-time claim** `ownerStartedAtSeconds` and refuses a token without it. The one-time precondition (no running owner at P0's merge) stands. | R8, 7, 18 |
| S3 | **Tokens stay stateless;** no rotating serial. A copied token stays valid until its expiry (at most an hour). | R19, 12.2 |
| S4 | **Accepted:** a stolen supervisor token's window is the owner's life (up to 8 hours), mitigated by refusing renewal once the owner is superseded or stopped. | 12.2 |
| S5 | **Accepted:** root inside the container can read the active turn's credentials over the socket; root is within the trust boundary. | R12, 12.2 |
| S6 | **Yes:** an emergency revocation runbook is written as its own part (R), `docs/OWNER_CREDENTIAL_REVOCATION.md`. | 12.3, 17 R |

Alternatives that these decisions reject, and that therefore have no scenario here: a longer drain grace (P1), an external
watchdog chain (P5), a broker that reads the computer record (S1), a rotating token serial (S3), and renewal bound to recent
activity (S4).

**Risks.**

1. The change to the claims schema and the child's environment touches every place a token is minted and every test that
   builds a child: P0's compile errors will list them; the plan is to fix them all in P0.
2. The SDK memoization (A2) and the per-request gateway token (A3) are the two places where "the child holds the new
   credentials" could silently be false; the scenarios "A turn that runs past the first hour keeps working" and "The model gateway
   token is read for each request" run with a clock that moves past the expiry.
3. The failure path is easy to get subtly wrong because every number is a margin on another. The arithmetic of section 4 is
   asserted by a vitest test over the constants, and the scenarios use the same constants.
4. A model that is asked to sleep eleven times may not (section 19 step 2).
5. The first hour of every owner that is deployed is exercised by the proof only if the proof is run; the real first renewal
   happens in the field at 40 minutes. The alarm on `owner_credentials_refresh_failed` is how a regression shows.

## 21. What changes in existing tests and files

`features/owner_supervisor_server.feature` (the two scenarios that move the clock 3000 seconds past the bootstrap: their steps
also set `ownerCredentialsExpireAt`; the "lifetime" stop outline is extended in A1), `features/computer_owner_long_lived.feature`
(the step "the owner was bootstrapped 3000 seconds ago"), `features/computer_owner_supervisor.feature` (the watchdog and
"An owner stops before the credentials it holds expire" scenarios: the latter now describes the lease and stops with the reason
`credentials`), `features/owner_credential_broker.feature` (the claim in the answers), `features/owner_host_token.feature`
(the claim), `features/supervisor_role_policy.feature` and `features/owner_role_policy.feature` (unchanged),
`conversation/test/session-token.test.ts`, `owner-supervisor-protocol-schema.test.ts`, `computer-image-structure.test.ts`,
`container-owner-config.test.ts`, `owner-session-env.test.ts`, `route-audience.test.ts`, `dynamo-messaging-store.contract.test.ts`,
`computer/test_owner_container.sh`, and `docs/OWNER_SUPERVISOR_PROTOCOL.md` sections 1.1, 3, 8 and 13 (the reserved rows, the
lifetime constant and the live-proof item 8, which point here). The list is the author's reading of the code; the implementer
finds the rest by running the gates.
