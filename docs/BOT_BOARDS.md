# Bot boards (Milestone 2 contract)

> **Status:** CONTRACT, specification only. Nothing on this page is built. It is the contract between Chatticus and
> the Kanbus cloud store that Chatticus consumes. The behavior is in four draft features:
> [`bot_board_tool.feature`](../features/bot_board_tool.feature),
> [`bot_board_access.feature`](../features/bot_board_access.feature),
> [`bot_board_task_migration.feature`](../features/bot_board_task_migration.feature) and
> [`web_bot_boards.feature`](../features/web_bot_boards.feature). None is in `features/cucumber-features.txt`; each is
> registered, with its steps, by the part of Milestone 2 that implements it. The decisions are the owner's, recorded on
> Kanbus epic `chatticus-c5f14c`. Where the decisions are silent this page says so in section 10 and does not guess.

## 1. What this is

Each bot has one internal board of its own work. It replaces the thin Task item ([Tasks](TASKS.md)): the `task` tool, the
DynamoDB task records and the web task list go, in one cutover, with a one-time migration. The evidence-to-complete rule
is kept. The board is not stored by Chatticus. It lives in the Kanbus cloud store (the Virtuus store and `kanbus-api`),
which the Kanbus project owns, and follows the Kanbus issue model exactly. Chatticus calls that service from its front door
and draws the result with the same `@kanbus/ui` component that already draws project boards
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
- The Kanbus service is deployed by CDK in `infra/`, one per environment, in the Chatticus production account (section 9).

## 3. Mapping

| Chatticus | Kanbus |
| --- | --- |
| environment (development, staging, production) | one bucket and one table per environment, deployed from the Kanbus artifact |
| organization id | tenant |
| bot id | project (one Kanbus project per bot) |
| a card | an issue |
| a bot's board | the issues of that project |

The front door supplies tenant and project from the verified caller and the bot being addressed. A request body never
names either (`bot_board_access.feature`). This needs per-request tenant and project resolution (`kbs-9cb5cb40`).

## 4. Kanbus semantics Chatticus relies on

Taken from the Kanbus project, not designed here. If one changes, the features change.

- **Ids.** `{project_key}-{uuid-v4}`; the file name is the id. Short ids are display only and never stored.
- **Required fields.** `id, title, description, type, status, priority (int), assignee, creator, parent (nullable),
  labels[], dependencies[], comments[], created_at, updated_at, closed_at (nullable), custom{}`. Unknown keys are
  preserved. Timestamps are RFC 3339 UTC with milliseconds and a `Z`. A comment is `{id uuid, author, text, created_at,
  comment_type "default"}`. Every mutation writes one event file.
- **Validation.** Type is in the hierarchy; priority is in the configuration; status is in the type's workflow; status is
  `closed` if and only if `closed_at` is set; a parent exists and is the next hierarchy level; dependency targets exist.
  A transition must be in the type's workflow map. Closing sets `closed_at`; reopening clears it.
- **Conditional writes.** Create is conditional on absence. Update and delete carry the expected revision. A stale
  revision is a conflict that names the current revision.
- **Idempotent retries.** `X-Operation-Id`: the same id with the same body replays the first result; the same id with a
  different body is rejected.
- **Honest catalog lag.** The S3 record is canonical. The DynamoDB catalog is an index; when it is behind the response
  says `catalog_pending`. The catalog can be rebuilt from the S3 records; that is a Kanbus-owned operation.

## 5. What Chatticus calls

Chatticus never reads or writes the store directly. The middle column is the Kanbus API's, through the TypeScript client
(`kbs-a19d1443`); the left column is Chatticus's.

| Chatticus operation | Kanbus call | Rules Chatticus adds before the call |
| --- | --- | --- |
| list a board | list issues of the project | membership of the bot's organization |
| read a card | get issue by id | the same |
| create a card | create issue with an operation id | write role (the bot itself, or an owner); title required |
| move, edit or comment | update issue with the expected revision and an operation id | write role |
| complete | one update to a closed state with the evidence recorded | evidence required and not blank |
| close | one update to a closed state with the reason recorded | reason required and not blank |
| reopen | update to an open status | write role |
| reparent, add a dependency | update parent or dependencies | write role; depends on `kbs-8283b923` |
| delete | delete with the expected revision | owner role |
| rebuild the index | Kanbus-owned operation | operator only (question 13) |

The board tool is the bot's view of these calls. Its actions: create, get, list, update (title, description, priority,
labels, status), comment, complete, close, reopen, set parent, add a dependency. It reads the card first when the bot
supplies no revision, so that no write is blind (question 9). It carries an operation id derived from the turn, so a
retried turn does not repeat its writes (question 10). Its result says saved only after the store confirmed the record,
failed when it did not, and that a listing may be behind when the response said `catalog_pending`.

## 6. Access

Detailed in [`bot_board_access.feature`](../features/bot_board_access.feature).

| Caller | Reads | Changes |
| --- | --- | --- |
| a member who can see the bot | yes | no |
| an owner of the organization | yes | yes |
| the bot itself | yes | its own board only |
| another bot | no | no |
| a member of another organization | not found | not found |
| the computer | never | never |

Role and membership are read at every request, so removal and demotion take effect at the next request. A denied request
is not found for a stranger and forbidden for a member without write, and is recorded without card text.

## 7. The web panel

Detailed in [`web_bot_boards.feature`](../features/web_bot_boards.feature). The Board tab keeps one panel and gains a
picker with two sections: Project boards (Kanbus projects in the computer's workspace, read from the files as today) and
Bot boards (read through the front door). Both go to `IssueCollection` from `@kanbus/ui`. A bot board works with the
computer off. A move shows saving, then saved, failed or changed by someone else, and a lagging board says so. Members who
cannot change cards see a read-only board. Phone and iPad layouts are specified.

## 8. The cutover from Task items

Detailed in [`bot_board_task_migration.feature`](../features/bot_board_task_migration.feature).

1. Land the board tool, the front door routes and the panel, with the Task item still present. No member-visible change.
2. Run the migration once per environment: every Task item becomes a card on the board of the bot that created it. The
   migration is idempotent, resumable, reports what it did, supports a dry run, and removes a Task item only after its card
   is confirmed saved. Items it cannot place are reported and kept; it never guesses a bot.
3. Verify that every Task item has a card with the same title, outcome, evidence and reason.
4. Retire the Task records and delete the Task tool, the Task HTTP routes, the Task codec and the web task list in one
   change. No flag, no dual read, no compatibility path (AGENTS.md).

Status mapping: `open` to `open`; `blocked` to `blocked`; `completed` to a closed card whose outcome is completed, with
the evidence; `closed` to a closed card whose outcome is closed, with the reason. How outcome, evidence and reason are
recorded on a Kanbus issue is open question 2. Provenance (creating bot, last updating bot) is carried, and the original
Task identifier is kept on the card.

## 9. Dependencies on the Kanbus project

Chatticus builds no code against `kanbus-api` until these land; the features are drafts for this reason.

| Need | Kanbus ticket |
| --- | --- |
| tenant and project resolved per request from the verified identity (blocking) | `kbs-9cb5cb40` |
| an indexed query budget instead of a project-count limit | `kbs-494ecd64` |
| a deployable artifact and CDK construct per environment | `kbs-4818904b` |
| service-to-service authentication | `kbs-f222b6ee` |
| a TypeScript client | `kbs-a19d1443` |
| parent and dependency writes through the API | `kbs-8283b923` |
| pure parsers for the offline project view | `kbs-460415fd` |

Scenarios that need parent and dependency writes carry `@kanbus-parent-writes`. Building on Kanbus Preview is accepted,
development first.

## 10. Open questions

Not decided. Each is a question for the owner, the Kanbus project, or both. None is answered by the features.

1. **Default Kanbus configuration for a new bot board.** Statuses, types, hierarchy and priorities: the Kanbus default, or
   something smaller for bots? The features assume `open`, `in_progress`, `blocked`, `closed`, the types task and epic,
   and epic over task for the parent scenarios.
2. **Evidence, reasons and outcome in Kanbus fields.** Kanbus has one closed status, closed if and only if `closed_at`.
   Where do the evidence of a completion, the reason of a closing, and the difference between completed and closed
   live: a typed comment, an agreed key in `custom`, a second closed-category status? The features say only that the
   card records them. The rule is fixed: a card closes only with evidence (complete) or a reason (close), and a plain
   status change into a closed status is refused.
3. **Admin role.** Roles today are owner and member (`MemberRole`). The decisions name owners and admins for editing. Is an
   admin role added, or is the rule owners only? The features say owners.
4. **Bot visibility.** "Members who can see the bot can see its board." Today every member sees every bot of the
   organization. If per-bot visibility arrives, the board follows the bot; no feature depends on it yet.
5. **Organization-wide view.** Is an all-bots view wanted (one view across the organization)? The features show per-bot
   boards only. It would need a Kanbus read across the tenant.
6. **Per-user and per-organization lists.** The decision says later. Not specified.
7. **A Task item with no creating bot, or whose bot was deleted.** The features report and keep it. Who decides where it
   goes: the owner, a fallback bot, a board of the organization?
8. **Delete.** Delete is specified for owners only, with the expected revision. Should a bot close and never delete?
9. **Revision for a blind update.** The tool reads then writes when the bot names no revision. Should the revision be
   shown to the model so it can see conflicts it caused itself?
10. **Operation ids.** Derived from the turn and the step so a retried turn repeats nothing. Confirm the Kanbus replay
    window outlasts the longest retry of a turn.
11. **Turn grant.** The Task tool was not a granted tool. Does the board tool stay outside the turn grant, or become a
    class a ceiling can bound?
12. **Limits.** The panel shows the 200 most recently changed cards, as the project board does. Is that right for a store
    with an indexed query, and what is the card-count and size limit of a board?
13. **Index rebuild.** Kanbus-owned. Who runs it for Chatticus (operator command, schedule), and how does the panel show a
    rebuild in progress?
14. **Deleting a bot.** What happens to its board: kept read-only, archived, or deleted with an export?
15. **Panel copy and gestures.** "Saved to the cloud", "Saving", "Failed to save", "Changed by someone else", dragging on
    iPad and a status menu on a phone are proposals for design review.
16. **Environment layout.** One bucket and one table per environment, per the decision. Confirm development, staging and
    production each get their own Kanbus service in the production account, and that the shared-stack rule in AGENTS.md
    is not extended to it.
