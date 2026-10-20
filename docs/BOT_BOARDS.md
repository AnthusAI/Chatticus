# Bot boards (Milestone 2 contract)

> **Status:** CONTRACT, partly built. Phase 2a (the server side of the bot's own board) is built behind a rollout switch:
> the board service module, provisioning at bot creation and the board tool, described in section 12 and specified by
> [`bot_board_tool.feature`](../features/bot_board_tool.feature),
> [`bot_board_owner_actions.feature`](../features/bot_board_owner_actions.feature) and
> [`bot_board_rollout.feature`](../features/bot_board_rollout.feature), all in `features/cucumber-features.txt`. Not built:
> the HTTP routes, the web Board tab and the Task migration, which stay in the drafts
> [`bot_board_access.feature`](../features/bot_board_access.feature),
> [`bot_board_task_migration.feature`](../features/bot_board_task_migration.feature) and
> [`web_bot_boards.feature`](../features/web_bot_boards.feature). The contract is between Chatticus and
> the Kanbus cloud store that Chatticus consumes. The decisions are the owner's, recorded on
> Kanbus epic `chatticus-c5f14c`. Where the decisions are silent this page says so in section 10 and does not guess. Decisions made on 2026-10-20 are
> listed in section 11.

## 1. What this is

Each bot has one internal board of its own work. It replaces the thin Task item ([Tasks](TASKS.md)): the `task` tool, the
DynamoDB task records and the web task list go, in one cutover, with a one-time migration. The evidence-to-complete rule
is kept. The board is not stored by Chatticus. It lives in the Kanbus cloud store (the Virtuus store and `kanbus-api`),
which the Kanbus project owns, and follows the Kanbus issue model exactly. Chatticus calls that service from its front door,
as a service principal acting for the person or bot (section 5), and draws the result with the same `@kanbus/ui` component that already draws project boards
([`web_kanbus_board.feature`](../features/web_kanbus_board.feature)).

Chatticus designs no store, no key layout and no file format. If a section here seems to need one, it is a question for
Kanbus and belongs in section 10.

## 2. Boundaries kept from the architecture

- Access is only through the Chatticus front door, after the organization membership check. No browser and no computer
  calls the Kanbus service.
- Bots act through a tool (section 5). The computer never touches the store and holds no credential for it.
- The board tool never summons the computer. It runs on a computerless worker, as the Task tool did
  ([`thin_task_item.feature`](../features/thin_task_item.feature)).
- There is no socket. The tool and the web panel make request and response calls; nothing outlives a turn or a request.
- The Kanbus service is deployed by CDK in `infra/`, one deployment per Chatticus environment, in the Chatticus production
  account (section 9).

## 3. Mapping

| Chatticus | Kanbus |
| --- | --- |
| environment (development, staging, production) | one `kanbus-api` deployment (one bucket and one table) per environment, deployed from the Kanbus artifact |
| organization id (lowercase UUID) | tenant |
| bot id (lowercase UUID) | project (one Kanbus project per bot) |
| a card | an issue |
| a bot's board | the issues of that project |

The front door supplies tenant and project from the verified caller and the bot being addressed. A request body never
names either (`bot_board_access.feature`). The Kanbus routes carry the board in the path (section 5), which is the
per-request scope of `kbs-9cb5cb40`. The one service principal Chatticus uses is granted every tenant of its deployment.

A new bot board is provisioned with Kanbus's own default configuration. `PUT /{tenant}/{project}/api/config` with an empty
body writes exactly what `kbs init` writes (`kbs-344f42ca`). Chatticus copies no status list and treats the generated
`.kanbus.yml` as the source of truth. Where this page or a feature must name a status it uses the Kanbus defaults:
`backlog`, `open`, `in_progress`, `blocked`, `closed`; the initial status is `open`; the default workflow is
`open` to `in_progress`, `closed` or `backlog`, and `closed` to `open`; the hierarchy is initiative, epic, task,
sub-task; the types are `bug`, `story` and `chore` as well.

## 4. Kanbus semantics Chatticus relies on

Taken from the Kanbus project, not designed here. If one changes, the features change.

- **Ids.** `{project_key}-{uuid-v4}`; the file name is the id. Short ids are display only and never stored.
- **Required fields.** `id, title, description, type, status, priority (int), assignee, creator, parent (nullable),
  labels[], dependencies[], comments[], created_at, updated_at, closed_at (nullable), custom{}`. Unknown keys are
  preserved. Timestamps are RFC 3339 UTC with milliseconds and a `Z`. A comment is `{id uuid, author, text, created_at,
  comment_type "default"}`. Every mutation writes one event file.
- **Validation.** Type is in the hierarchy; priority is in the configuration; status is in the type's workflow; status is
  `closed` if and only if `closed_at` is set (there is exactly one closed status); a parent exists and is the next hierarchy level; dependency targets exist.
  A transition must be in the type's workflow map. Closing sets `closed_at`; reopening clears it.
- **Conditional writes.** Create is conditional on absence. Update and delete carry the expected revision. A stale
  revision is a conflict that names the current revision.
- **Idempotent retries.** `X-Operation-Id`: the same id with the same body replays the first result; the same id with a
  different body is rejected.
- **Actor.** The caller is a service principal with an actor-delegation grant and sends `X-Kanbus-Actor:
  chatticus:user:<uuid>` or `chatticus:bot:<uuid>`. Kanbus records it as creator, comment author and event `actor_id`
  (`kbs-f222b6ee`).
- **Honest catalog lag.** The S3 record is canonical. The DynamoDB catalog is an index; when it is behind the response
  says `catalog_pending`. The catalog can be rebuilt from the S3 records; that is a Kanbus-owned operation.

## 5. What Chatticus calls

Chatticus never reads or writes the store directly. The middle column is the Kanbus API's, through the TypeScript client
(`kbs-a19d1443`); the left column is Chatticus's. The control plane calls `kanbus-api` as a service principal with an
actor-delegation grant, and sends `X-Kanbus-Actor: chatticus:user:<uuid>` for a member or `chatticus:bot:<uuid>` for a
bot. The board is in the path:

- `GET /{tenant}/{project}/api/config`
- `GET`, `POST /{tenant}/{project}/api/issues`
- `GET`, `PATCH`, `DELETE /{tenant}/{project}/api/issues/{id}`
- `POST /{tenant}/{project}/api/issues/{id}/comments`
- `GET /{tenant}/{project}/api/issues/{id}/events`
- `PUT /{tenant}/{project}/api/config` with an empty body provisions a board (`kbs-344f42ca`)
- `POST /{tenant}/{project}/api/board/archive`, `POST /{tenant}/{project}/api/board/restore` and
  `DELETE /{tenant}/{project}/api/board` manage the board lifecycle (`kbs-791a7373`, specified by Kanbus, not built yet;
  details below)

A board that the principal is not granted answers 403 without revealing whether it exists. `X-Operation-Id` idempotency,
`If-Match` revisions and `catalog_pending` are as in section 4.

| Chatticus operation | Kanbus call | Rules Chatticus adds before the call |
| --- | --- | --- |
| provision a board | `PUT config` with an empty body | when the bot is created |
| list a board | list issues of the project | membership of the bot's organization |
| read a card | get issue by id | the same |
| create a card | create issue with an operation id | the bot itself, or an owner; title required |
| move, edit or comment | update issue with the expected revision and an operation id | the bot itself, or an owner |
| complete | one update to `closed` with a closing comment holding the evidence and `custom.closing = "completed"` | evidence required and not blank |
| abandon (close) | one update to `closed` with a closing comment holding the reason and `custom.closing = "abandoned"` | reason required and not blank |
| reopen | update `closed` to `open`, which clears `closed_at` | the bot itself, or an owner |
| reparent, add a dependency | update parent or dependencies | the bot itself, or an owner; depends on `kbs-8283b923` |
| delete a card | delete with the expected revision | an owner only; a bot never deletes |
| archive, restore, purge a board | `board/archive`, `board/restore`, `DELETE board` (`kbs-791a7373`) | section 6 |
| rebuild the index | Kanbus-owned operation | operator only (question 10) |

The board tool is the bot's view of these calls. Its actions: create, get, list, update (title, description, priority,
labels, status), comment, complete, close, reopen, set parent, add a dependency. It has no delete action: bots close
cards and never delete them. It reads the card first when the bot supplies no revision, so that no write is blind
(question 6). It carries an operation id derived from the turn, so a retried turn does not repeat its writes
(question 7). Its result says saved only after the store confirmed the record, failed when it did not, and that a
listing may be behind when the response said `catalog_pending`.

Closing. There is one closed status. A plain status change into `closed` is refused. To complete a card the bot closes it
with a closing comment that holds the evidence and sets `custom.closing` to `completed`. To abandon a card it closes it
with a closing comment that holds the reason and sets `custom.closing` to `abandoned`. Reopening a closed card to `open`
is allowed. The evidence-to-complete rule is thereby kept.

## 6. Access

Detailed in [`bot_board_access.feature`](../features/bot_board_access.feature).

| Caller | Reads | Changes |
| --- | --- | --- |
| a member who can see the bot (every member of the organization today) | yes | no |
| an owner of the organization | yes | yes, and only owners delete cards |
| the bot itself | yes | its own board only, and it never deletes a card |
| another bot | no | no |
| a member of another organization | not found | not found |
| the computer | never | never |

Only organization owners edit a bot's board. There is no admin role today and none is specified. Role and membership are
read at every request, so removal and demotion take effect at the next request. A denied request is not found for a
stranger and forbidden for a member without write, and is recorded without card text.

When a bot is deleted its board is archived: it is no longer listed or writable, and an owner can restore it within thirty
days. It is purged thirty days after the bot is deleted. An owner may ask for immediate removal.

Board lifecycle as Kanbus specified it for `kbs-791a7373` (not built yet):

- `POST .../api/board/archive` sets `archived_at` and `purge_after = archived_at + KANBUS_ARCHIVE_RETENTION_DAYS`, a
  deployment setting that Chatticus sets to 30.
- `POST .../api/board/restore` restores the board; 409 if it is not archived or is already purged.
- `DELETE .../api/board` purges, only when archived; otherwise 409 `board_not_archived`. Immediate removal is archive
  then purge.
- All three need a provisioning grant on the board, are idempotent by `X-Operation-Id`, and are journaled.
- While a board is archived, principals without a provisioning grant get 404 `not_found` on every board route, with the
  same body as a board that does not exist. Provisioning principals can still `GET` config, issues and events. Every write
  returns 409 `board_archived`.
- A scheduled sweeper shipped with the deployable artifact (`kbs-4818904b`) purges boards past `purge_after`. Chatticus
  therefore calls only archive (the bot is deleted), restore (an owner restores within thirty days) and, when an owner
  explicitly asks for immediate removal, archive then `DELETE`. It never schedules the thirty-day purge itself.

## 7. The web panel

Detailed in [`web_bot_boards.feature`](../features/web_bot_boards.feature). The Board tab keeps one panel and gains a
picker with two sections: Project boards (Kanbus projects in the computer's workspace, read from the files as today) and
Bot boards (read through the front door). Both go to `IssueCollection` from `@kanbus/ui`. A bot board works with the
computer off. A move shows saving, then saved, failed or changed by someone else, and a lagging board says so. Members who
cannot change cards see a read-only board. Phone and iPad layouts are specified. An organization-wide view of every bot's cards is wanted later and is not a
priority; it must not be built now (section 11, item c). It is expected to use Kanbus's cross-board list
`GET /{tenant}/api/issues?projects=a,b`, which is bounded per query (`kbs-494ecd64`).

## 8. The cutover from Task items

Detailed in [`bot_board_task_migration.feature`](../features/bot_board_task_migration.feature).

1. Land the board tool, the front door routes and the panel, with the Task item still present. No member-visible change.
2. Run the migration once per environment: every Task item becomes a card on the board of the bot that created it. The
   migration is idempotent, resumable, reports what it did, supports a dry run, and removes a Task item only after its card
   is confirmed saved. Items it cannot place (no creating bot, or that bot is deleted) are reported to the organization's
   owners and kept until an owner has seen the report; they are then deleted. It never guesses a bot, and nothing is
   deleted silently.
3. Verify that every Task item has a card with the same title, closing, evidence and reason.
4. Retire the Task records and delete the Task tool, the Task HTTP routes, the Task codec and the web task list in one
   change. No flag, no dual read, no compatibility path (AGENTS.md).

Status mapping: `open` to `open`; `blocked` to `blocked`; `completed` to a `closed` card with a closing comment holding
the evidence and `custom.closing = "completed"`; `closed` to a `closed` card with a closing comment holding the reason and
`custom.closing = "abandoned"`. Provenance (creating bot, last updating bot) is carried, and the original
Task identifier is kept on the card.

## 9. Dependencies on the Kanbus project

Chatticus builds no code against `kanbus-api` until these land; the features are drafts for this reason.

| Need | Kanbus ticket |
| --- | --- |
| per-request tenant and project scope, board in the path (blocking) | `kbs-9cb5cb40` |
| an indexed query budget instead of a project-count limit | `kbs-494ecd64` |
| a deployable artifact and CDK construct per environment | `kbs-4818904b` |
| service principals, actor-delegation grant and the `X-Kanbus-Actor` header | `kbs-f222b6ee` |
| a TypeScript client | `kbs-a19d1443` |
| parent and dependency writes through the API | `kbs-8283b923` |
| board provisioning (`PUT config` with an empty body) | `kbs-344f42ca` |
| board deletion: archive, restore, purge (routes in section 6) | `kbs-791a7373` |
| pure parsers for the offline project view | `kbs-460415fd` |

Deployment. The control plane stack of each environment holds one `KanbusApi` construct from `@kanbus/cdk` (installed from the
GitHub release tarball `kanbus-cdk-v0.2.0`, integrity pinned in the lockfile), which brings its own bucket, catalog table,
service API (`kanbus-<environment>-service`, AWS_IAM), API function, hourly sweeper and sweep rule. Chatticus writes no store of
its own. Its service principals are the Front Door role (`provision` and `delegateActor`, every tenant) and the turn executor
role (`delegateActor`, every tenant, no `provision`); the computer, the owner roles and the credential broker never touch the
store. The service URL reaches those two functions as `CHATTICUS_KANBUS_API_URL`. The rollout list `KANBUS_BOARD_ENVIRONMENTS`
in `infra/lib/environments.ts` is `development` only until the owner extends it to staging and production.

Scenarios that need parent and dependency writes carry `@kanbus-parent-writes`. Building on Kanbus Preview is accepted,
development first.

## 10. Open questions

Not decided. Each is a question for the owner, the Kanbus project, or both. None is answered by the features.

1. **Workflow transitions beyond the stated defaults.** Only `open` to `in_progress`, `closed` or `backlog`, and `closed`
   to `open`, are stated. The scenarios that move a card to or from `blocked` assume the transitions of the generated
   `.kanbus.yml`. Confirm them against the configuration `PUT config` writes.
2. **Per-user and per-organization lists.** The decision says later. Not specified.
3. **Bot visibility.** Today every member sees every bot of the organization, so every member sees every board. If
   per-bot visibility arrives, the board follows the bot.
4. **Delivery of the migration report.** Decided: unplaceable Task items are reported to the owners and deleted after an
   owner has seen the report. Open: where the report is shown, what counts as having seen it, and whether one owner
   suffices.
5. **Archive details.** Decided: archive, restore within 30 days, purge by the Kanbus sweeper, immediate removal only on
   an owner's explicit request. Open: how an owner finds and restores an archived board in the product, and what happens
   to the restored board when the bot itself was deleted and not restored.
6. **Revision for a blind update.** The tool reads then writes when the bot names no revision. Should the revision be
   shown to the model so it can see conflicts it caused itself?
7. **Operation ids.** Derived from the turn and the step so a retried turn repeats nothing. Confirm the Kanbus replay
   window outlasts the longest retry of a turn.
8. **Turn grant.** The Task tool was not a granted tool. Does the board tool stay outside the turn grant, or become a
   class a ceiling can bound?
9. **Limits.** The panel shows the 200 most recently changed cards, as the project board does. Is that right for a store
   with an indexed query (`kbs-494ecd64`), and what is the card-count and size limit of a board?
10. **Index rebuild.** Kanbus-owned. Who runs it for Chatticus (operator command, schedule), and how does the panel show a
    rebuild in progress?
11. **Panel copy and gestures.** "Saved to the cloud", "Saving", "Failed to save", "Changed by someone else", dragging on
    iPad and a status menu on a phone are proposals for design review.
12. **Deployment shape.** Decided, see section 11 (l).
13. **Bot creation when provisioning fails.** The contract says the board is provisioned when the bot is created and does not
    say what happens when that fails. Phase 2a lets the error propagate: the board is provisioned before the bot is stored, a
    failure fails the creation (HTTP 502 with the reason) and nothing is stored, and a bot that fails to store after its board was provisioned has the board archived (best effort). Lazy provisioning on first use is not possible
    because the turn executor role has no `provision` grant. Decide: fail creation (as now), create the bot and retry
    provisioning later (needs a retry owner), or grant the executor `provision`.
14. **Closing as two writes.** Kanbus has no comment inside an update, so a close is a comment and then an update (section 12).
    A failed second write leaves a closing comment on an open card. Ask Kanbus for an update that carries a closing comment, or
    accept the two writes.
15. **`custom.closing` on reopen.** Resolved by Kanbus: null sets the key to null.
16. **Client surface.** Resolved except one: create takes no id (the server makes `<project_key>-<uuid>`) and list pages never carry `catalog_pending`, so those scenarios stay draft; `dependencies` is typed from client 0.1.1.
17. **Replay and `If-Match`.** Resolved by Kanbus: `If-Match` is part of the hashed request (section 12).
18. **Relation writes in the deployed artifact.** Resolved: available in `@kanbus/cdk` 0.2.0 (Kanbus 0.39.0).
19. **Removing a member.** The membership store has no removal, so "a member who is removed stops reading" cannot be
    specified yet; the role-change scenarios are real, the removal scenario stays in `bot_board_access.feature`.
20. **Default card type.** `create` defaults the type to `task` because the client requires a type; confirmed by Kanbus.

## 11. Decided

Owner decisions of 2026-10-20 (Ryan):

- (a) 2026-10-20: only organization owners edit a bot's board. There is no admin role today; none is specified.
- (b) 2026-10-20: every member of the organization who can see the bot can see its board, read-only for non-owners.
- (c) 2026-10-20: an organization-wide view of all bots' cards is wanted later, is not a priority and is not built now. It
  is expected to use Kanbus's cross-board list `GET /{tenant}/api/issues?projects=a,b`, bounded per query (`kbs-494ecd64`).
- (d) 2026-10-20: Task items that cannot be placed on a board (no creating bot, or that bot is deleted) are reported to the
  owner and deleted after the owner has seen the report. Nothing is deleted silently.
- (e) 2026-10-20: bots close cards and never delete them. Owners may delete cards.
- (f) 2026-10-20: when a bot is deleted its board is archived (not listed, not writable, restorable) and purged after 30
  days. An owner may ask for immediate removal.

Answers from the Kanbus project, 2026-10-20:

- (g) A new bot board is provisioned with Kanbus's own default configuration (`PUT config`, empty body, same as `kbs init`).
  Chatticus copies no status lists; the generated `.kanbus.yml` is the source of truth. Defaults are named in section 3.
- (h) One closed status. Completed: close with a closing comment holding the evidence plus `custom.closing = "completed"`.
  Abandoned: close with a closing comment holding the reason plus `custom.closing = "abandoned"`. Reopen (`closed` to
  `open`) is allowed and clears `closed_at`.
- (i) The control plane acts as a service principal with an actor-delegation grant and sends `X-Kanbus-Actor`
  (`chatticus:user:<uuid>` or `chatticus:bot:<uuid>`), recorded as creator, comment author and event `actor_id`.
- (j) Routes carry the board in the path (section 5). An ungranted board is 403 without revealing existence. One
  `kanbus-api` deployment per Chatticus environment; the service principal is granted every tenant. Tenant is the
  organization id and project is the bot id, both lowercase UUIDs.
- (k) Kanbus stories: `kbs-9cb5cb40`, `kbs-494ecd64`, `kbs-4818904b`, `kbs-f222b6ee`, `kbs-a19d1443`, `kbs-8283b923`,
  `kbs-344f42ca`, `kbs-791a7373`, `kbs-460415fd` (section 9).
- (l) 2026-10-20: one `kanbus-api` deployment (bucket, table, API, sweeper) per Chatticus environment, inside that
  environment's control plane stack, in the production account. Each environment owns separate resources and its API invoke
  grant names only that environment's two roles, so a staging role cannot reach the development API or the reverse. The
  shared-stack rule in AGENTS.md is not extended to it. Rollout: development first (`KANBUS_BOARD_ENVIRONMENTS`).

## 12. Phase 2a: the server side of the bot's own board

Code: `conversation/src/board/` (the board service module and its client wiring) and `conversation/src/pi/bot-board-tool.ts`
(the `board` tool). Chatticus reaches the board service only through the Kanbus project's published TypeScript client
`@kanbus/api-client` 0.1.1, installed from its GitHub release tarball with the integrity pinned in the lockfile; the pin is `@kanbus/api-client` 0.1.1 together with `@kanbus/cdk` 0.2.0, as a pair (the same
pattern as `@kanbus/ui` and `@kanbus/cdk`). It makes no HTTP call of its own to the board service and re-implements none of
Kanbus's validation: it sends the request and maps the answer.

**Rollout switch.** The whole capability is active only where `CHATTICUS_KANBUS_API_URL` is set, which today is the
development environment only (`KANBUS_BOARD_ENVIRONMENTS`). Where it is absent no board service is built, bot creation
provisions nothing, and the `board` tool is not offered to the model. The old `task` tool is untouched in both cases
([`bot_board_rollout.feature`](../features/bot_board_rollout.feature)).

**Signing and actor.** Each request is signed with SigV4 for `execute-api` using the function role's own credentials
(`createSigV4SignedFetch`, built on `src/acceptance/sigv4.ts`). The signing is inside the client's `fetch` option, which receives the final URL and the exact body string, as the
client's README shows; the `headers` hook takes no arguments and runs before the body is serialized, so it is never used to sign. Credentials are read from the role's provider on every request. The request carries `x-amz-content-sha256`, the hash of the exact body, and the signature covers it. A role with `delegate_actor` must send `X-Kanbus-Actor` on every request, reads included, so the
client is built per acting person or bot with the header in its `headers` hook, and writes also pass `actor`. The actor is
`chatticus:bot:<botId>` for the bot's tool calls and `chatticus:user:<userId>` for owner actions.

**Who runs what.** The front door role holds `provision` and `delegateActor`; the turn executor role holds only
`delegateActor`. Provisioning, archive and restore therefore run in the front door; the board tool runs in the turn executor.
Because the executor cannot provision, a board is provisioned when the bot is created and not lazily on first use.

**Provisioning.** `provisionBotBoard` is `client.board(organizationId, botId).provision()` with no body (Kanbus's default
configuration). A created board and a 409 `board_exists` both count as provisioned. Its operation id is derived from the
organization and bot ids alone, so a retry replays.

**Operation ids.** `deriveBoardOperationId` hashes (SHA-256) the board, the action, the card id, the step and an operation key (so a model-chosen key reused on another card is a different change) into a
UUID. The request body is not an input, so reusing a key for a different change reaches Kanbus unchanged and is refused
there with `operation_conflict`. The tool's operation key is `<turnId>/<toolCallId>` unless the model passes
`operation_key`, which a failed (unconfirmed) result hands back, with the `revision_used`, so the same change can be repeated exactly across turns: Kanbus compares `If-Match` as part of the request, so a retry must resend the revision of the first attempt, not a fresh read. Within one tool call the durable tool memo (`api.memo`) holds that revision; across calls the model passes `operation_key` and `revision_used` back, as the tool description tells it. A call that
is interrupted and run again has the same turn and tool call ids, hence the same operation ids, hence it replays; the tool is
registered replay-safe for that reason. When the model names no revision the tool reads the card first and remembers the
revision it read in the durable tool memo, so a replay writes against the revision of the first attempt.

**Replay.** Kanbus hashes method, path, body, actor and `If-Match` for idempotency, so a retry must resend the original `If-Match`. The tool remembers the revision it read (durable tool memo) and resends it; a model-supplied different revision under the same `operation_key` is an `operation_conflict`, reported as not saved with guidance to use a new `operation_key`.

**Types.** The tool never changes a card's type (Kanbus refuses a change to or from a hierarchy type with 409 `type_change_unsupported` until kbs-1a88cdf5); the type is chosen at create, default `task`. The 409 codes `relation_target_missing`, `issue_has_children`, `issue_has_dependents`, `hierarchy_violation` and `type_change_unsupported` are reported as not saved validation failures.

**Dependencies.** `@kanbus/api-client` 0.1.1 types `dependencies` (`KanbusDependencyLink`, type `blocked-by` or `relates-to`). A patch's `dependencies` array replaces the existing links, so adding or removing one reads the card, computes the full new list and sends all of it, against the card's revision like any update. A missing target is reported as not saved with Kanbus's `relation_target_missing`.

**Closing.** Kanbus's API has no comment inside an update, so completing or closing a card is two writes with two derived
operation ids: a comment holding the evidence or reason (`Completed. Evidence: ...` or `Closed. Reason: ...`), then an update
to `closed` with `custom.closing`. If the second fails the result says the comment was saved and the card was not closed. A plain status
change to `closed` is refused before any call. Reopening sets `status` to `open` and `custom.closing` to JSON null: Kanbus merges `custom` shallowly by key and a null sets the key to null, so a reopened card reads as not closed.

**Honest results.** A write is reported `saved` only after the store answered with the record. A response that is an
error is reported as what it said (denied, not found, conflict with the current revision, validation failure naming the
field, operation id reused, archived). An unreachable store, a 5xx or an unrecognized answer is `not_saved`: the change
may or may not be stored. A write answered with `catalog_pending` is reported saved with a note that the listing may be
behind.

**Owner rules inside the module.** Reads need membership in the organization (a stranger gets not found); writes need an
owner, or the bot on its own board; a bot never deletes and never touches another bot's board; role is read from the
membership store at every call. Archive and restore need an owner and the front door's provisioning role. Chatticus never
calls purge. The HTTP routes that will expose these to members are a later phase.

**Tests.** `conversation/features-support/fakes/fake-kanbus-board-service.ts` models the published Kanbus behavior of
section 4 and the Kanbus service README in process, as a `fetch` the real client talks to. It verifies the SigV4 signature itself (it recomputes it over the received method, canonical path and query, signed headers and the hash of the received body bytes, with the role's secret) and refuses a body signed as empty, a body or header changed after signing, a missing payload hash and any unsigned header; it also refuses wherever the scenarios
do not need it to accept: unregistered roles, a missing or malformed actor header for a delegating role, an
actor header from a non-delegating role, a missing or non-UUID operation id, a missing `If-Match`, unknown fields, wrong
hierarchy levels, workflow transitions the generated configuration does not allow, and every route of an archived board.

