# Live files protocol (Phase 3 contract)

> **Status:** CONTRACT. Nothing on this page is built. It is the exact interface that
> several people build against in parallel for Phase 3 of
> [Long-lived computer, file protocol and preview](LONG_LIVED_COMPUTER.md): the shared
> schemas (F0), the server (A1, A2), the container (C) and the web app (W). It builds
> on the merged and live [Owner supervisor protocol](OWNER_SUPERVISOR_PROTOCOL.md) (Phase
> 2a) and on the read-only snapshot file routes of Phase 1. Every claim about today's code
> carries a `file:line` or file reference into `origin/develop` at the time of writing.
> Every statement about the proposal is the contract; a guess is labelled ASSUMPTION. The
> wire schemas in section 5 are code to be added in
> `host-protocol/src/live-files.ts` and `host-protocol/src/live-file-rules.ts` by the
> foundation step F0; until F0 merges, this page is the source. Once it merges, where
> this page and those files disagree, fix the page. The draft behavior is in
> [`features/computer_file_live.feature`](../features/computer_file_live.feature).

## 1. What Phase 3 is

A member of the organization opens the Files panel and sees the files on the computer **as
they are now**, not as of the last publish, and can change a text file. While the computer
is off nothing changes: the Front Door answers from the saved snapshot, as it does today.
While a long-lived owner runs, the same routes are answered by the owner. Nothing connects
to the owner: the Front Door leaves a request in the table, the owner finds it in its next
poll, runs it through the unprivileged file helper and posts the result.

```
Browser (Files panel)
  | GET/PUT /orgs/T/computer/files/...   POST .../files/watch
  v
Front Door Lambda
  | 1. member principal, rate limit, path rules
  | 2. choose source: live owner? (liveOwnerOf + protocol + state)  else snapshot
  | 3. write: audit record first, then queue the request (one transaction with the stop guard)
  | 4. wait up to 8 s for the result item, 250 ms apart; on timeout read falls back, write reports
  v
Messaging table   T#computer#fileops  (requests and results, deleted when read)
                  T#computer#audit    (written by the Front Door only)
  ^
  | poll response carries file_requests;  POST /host/owner/file-results carries the answer
  |
Supervisor (root, in the container)         no AWS access to either key family
  | spawns, with a timeout and a concurrency of 2
  v
File helper (uid 2000, through chatticus-shell)    list | stat | read(range) | write(atomic, precondition)
  workspace
```

What does **not** change: no socket, no inbound port, no new AWS resource and no CDK change.
Both owner roles keep their policy files; the new key families are simply outside them.

### 1.1 Out of Phase 3 (reserved, nothing implemented)

| Reserved | Phase | Rule until then |
| --- | --- | --- |
| `GET .../files/recent` and watcher-based change events | 5 | The panel reacts to the turn's tool events and to a cheap `stat` probe (section 10). |
| Delete, move, rename, upload, download of large files, creating directories | 5 | The helper has no such operation. Creating a file needs an existing parent directory. |
| Writing a binary file or a file over 256 KiB | later | Writes are UTF-8 text up to 256 KiB. |
| Waking a stopped computer from the Files panel | open question Q1 | A write while the computer is off is refused (409 `computer_not_live`). |
| Customer-account computers | later (design 10.2) | They have a host worker, no owner: `liveOwnerOf` is false, so they are always answered from the snapshot. |
| Previews, background processes | 4 | |
| Reading the audit log from the web app | open question Q4 | Operators read the table. |

## 2. What is wrong or underspecified in the design, given the code now live

The design document is from before Phases 1 and 2a. These are the places where it is wrong,
silent or contradicted by `origin/develop`. Each one is settled by a decision in section 3
(L-numbers) unless it says "open".

| # | What the design says or omits | What the code says | Settled by |
| --- | --- | --- | --- |
| W1 | 7.1: "If the computer record says a healthy owner is live, use the owner." | `liveOwnerOf` (`domain/computers.ts:119`) is true for an owner that is booting, hydrating, serving, draining or stopping. A live read of a hydrating disk returns an empty or partial workspace; a write to a stopping owner is lost after the final publish. | L2, L3 |
| W2 | 7.5: "the open file panel keeps it in the 0.5 second mode." No signal path is named. | The poll request is strict and carries nothing about a panel (`ownerPollRequestSchema`); the server learns of a panel only from requests it sees. At the 10 second idle tier, the first request after a quiet time is picked up 0 to 10 seconds later, so about one in five first reads times out against an 8 second wait. | L6, L7 |
| W3 | 9 and 6.1: the 0.5 second mode costs 0.0054 USD/h. | OWNER_SUPERVISOR_PROTOCOL C13 revised the poll cost to one conditional write plus two or three reads: about 0.7 cents an hour at 1 s, so about 1.4 cents an hour at 0.5 s, which is **the cost of the computer itself** (about 1.5 cents an hour with its address). The design's number counted reads only. | L7, Q3 |
| W4 | 7.5: items "TTL 120 seconds". | DynamoDB expires items by TTL lazily, typically within 48 hours (the table uses `expires_at`, `infra/lib/thin-turn-stack.ts:50`). A revealed secret, or the content of an edit, would sit in the table long after "expiry". | L10 |
| W5 | 7.5: result route `/host/owner/fileops/{opId}/result`. | `authenticateOwnerHostRequest` matches the owner routes by exact suffix (`OWNER_COMPUTER_ROUTES`, `http/owner-host-auth.ts:27`); a path parameter would not match and would fall through to the invoke key gate. | L8 |
| W6 | 7.5: the Front Door "waits up to 8 seconds" and the response follows. Silent on what a timeout means for a write. | A timeout does not mean the owner did not run the request. A write the owner already took can still land. | L9 |
| W7 | 6.4 and 7.5 list activity that resets the idle clock "a file request". | The stop predicate (`stopVeto`, `domain/owner-supervisor.ts`) knows parked work and live turns only, and the supervisor's idle clock restarts only at a child exit (`startIdleClock` in `onChildExit`, `supervisor.ts`). A file edit would neither veto an idle stop nor postpone it, and a request queued the instant a stop is approved would be lost with its write. | L11, L12 |
| W8 | 6.6: "Quiet publish 30 seconds after the last write ... a file edit landed." | The supervisor schedules a publish check only after hydration, after a child exit and after a publish (`nextPublishCheckAtMilliseconds`); it never publishes while a child runs (OWNER_SUPERVISOR_PROTOCOL C14). An edit alone would wait up to 10 minutes, and an edit during a long turn would wait for the turn. | L13, Q11 |
| W9 | 7.5 is silent on the dirty flag. | `disk_dirty` is set only when a disk-writing tool answers (`recordComputerToolAnswered`, `domain/computers.ts:431`), and a dead owner's record is settled only when the disk is dirty (`settleComputerIfHostLost`, `:235`). An edit by a person on a dead owner would be lost silently and unrecorded. | L14 |
| W10 | 7.5: "the same helper started through the shell launcher". | The helper has `read` (whole file, base64), `write` (in place, `mkdir -p`, no precondition, not atomic), `stat`, `realpath` and no listing, no range, no hash, no size cap (`pi/owner-file-helper.ts`). A FIFO or a device would hang a read; a 2 GiB file would exhaust 512 MiB. A reader can see a half-written file. | L15, L16 |
| W11 | 7.5: the supervisor runs the operation. | After every child exit and in the stop sequence the supervisor kills **every process of uid 2000** (`UnprivilegedProcessSweeper`, `supervisor.ts` `onChildExit`, `performStop`). The helper runs as that uid, so a sweep would kill an operation in flight. | L17 |
| W12 | 7.6: secret names `.env*`, `*.pem`, `id_*`, `.aws/credentials`, `.git-credentials`, `.npmrc`; "a reveal call". | Phase 1 has a different list (`snapshot/files.ts` `SECRET_NAME_PATTERNS`: adds `.key`, `.p12`, `.pfx`, `credentials`, `.netrc`, the whole of `.ssh` and `.aws`; lacks `.git-credentials`) and **no reveal**. Two lists in two places is a defect. | L18 |
| W13 | Silent on the record. | `recordHostSnapshotPublished` and `recordHostHydrated` read the whole computer record and `putComputer` it back (`domain/computers.ts:343-391`, `dynamo-messaging-store.ts:525`). Any field a conditional update wrote between the read and the put (a dispatch, a stop approval, and now the interactive window) is reverted. A quiet publish after every edit makes this race frequent. | L19 |
| W14 | 7.5: "up to 256 KiB inline". | A DynamoDB item is limited to 400 KB. 256 KiB of binary is 349,528 bytes of base64 plus attributes: it fits with about 50 KB to spare, and a write of text up to 256 KiB fits easily, but the cap is a ceiling the item size test must hold. | L20 |
| W15 | 7.2: `If-Match` on the hash the UI last saw. | A stale-fallback read answers from the snapshot; a hash from there is the snapshot's, not the disk's. Editing against it produces a spurious conflict or a silent overwrite of unpublished work. | L5 |
| W16 | 7.5: "The Front Door writes audit records ... hash before and after." | The Front Door knows the hash of the bytes it sent (after) and the hash the person expected (before). It does not know what the owner actually replaced unless the owner says so. The owner is not trusted for the trail. The design also leaves open whether the record exists when the Front Door gives up waiting (a late result). | L21 |
| W17 | 7.2 shows plain responses and no provenance fields. | Phase 1 responses carry `source: "snapshot"`, `as_of`, `masked`, a `{ error, message }` error body, and the web types `source` as the literal `"snapshot"` (`web/lib/computer-files.ts:19`, `snapshot/files.ts` `SNAPSHOT_FILE_ERROR_STATUS`). The live routes must extend these, not replace them. | L1, L4 |
| W18 | 7.6: "A per-user limit ... so the poll channel cannot be flooded." No number, no store, no per-computer bound. | The only counter in the store is the organization-creation bucket (`incrementOrganizationCreationAttempts`, `dynamo-messaging-store.ts:216`). Each waiting request holds a Front Door invocation for up to 15 seconds. | L22 |
| W19 | 6.8 and the contract C6: protocol skew is handled by draining owners below a minimum version. | The drain on version is Phase 2b: the server only logs a low version (`pollOwner`, `owner_protocol_version_low`). An owner up to 50 minutes old will not understand `file_requests`. | L3 |
| W20 | Header: "Nothing on this page is built." Section 4 describes "today". | Phases 1 and 2a are merged and live. Sections 4.1 to 4.3 describe the system before Phase 2a. | corrected in the design document by this change |
| W21 | 7.2 and 7.3: symlinks are shown and followed only inside the index. | A live write through a symlink has two readings: replace the link, or write the file it points to. An atomic rename over the link would replace the link. | L16 |
| W22 | 7.6: "Writes under `.git/` are refused (a hook would run as the shell user ...)". | That is a defense for the person's click, not a privilege boundary: the shell user can write `.git/hooks` itself. The rule must also hold after links are resolved, or a link named `notes` to `.git/config` defeats it. | L23 |
| W23 | 7.6 "Who": the existing `resolveUserPrincipal` enforces membership. | The membership cache lives 30 seconds (`MembershipCache.timeToLiveMilliseconds`): a removed member can still write for up to 30 seconds. The principal can be an integration-test principal. Only `kind: "user"` with a user id can be audited. | L24 |
| W24 | 7.3 and 7.5: the viewer reads in ranges. | Each ranged read of a live file must hash the whole file (the ETag is the whole-file hash). At 256 KiB a page, a 50 MiB file is 200 pages of 50 MiB hashed each. | L15 (8 MiB cap), Q6 |
| W25 | `owner-role-policy.json` `MessagingWritable` lists `T#computer#record`. | The per-turn child may write the computer record directly. The interactive window and the file-operation token on that record are therefore advisory against a compromised child: it can make the owner poll fast or delay a stop, not forge a request, a result or an audit record, which live in other partitions. | L25 |

## 3. Decisions made in the contract

The numbers are this page's own (L1, L2, ...). D8, D9 and D14 of the design are unchanged and
used as stated: every enabled organization member reads and writes, the edit is direct with
a hash check and an audit record, audit retention is 90 days.

| # | Decision | Why |
| --- | --- | --- |
| L1 | **The routes of Phase 1 stay and grow.** `GET /orgs/{t}/computer/files`, `/stat`, `/content` keep their paths, their `{ error, message }` error body and `Cache-Control: private, no-store`. Responses gain `source: "live"`, `stale`, `fallback_reason`, `modified_at`; content responses gain `revealed` and `editable`. New: `PUT .../files/content`, `POST .../files/reveal`, `POST .../files/watch`. | One API with a `source` field is the design's own rule (7.1). No second path. |
| L2 | **Live is chosen by one predicate**, `liveFileSourceOf`: `liveOwnerOf` is true, `ownerProtocolVersion >= 2`, the owner's last polled state is `idle`, `serving`, `publishing` or `draining`, `ownerStopApprovedAt` is unset and `hydrateRequired` is false. Otherwise the answer comes from the snapshot. | W1, W19. `pollState` is already stored on the worker item (`store/codecs/worker.ts`). |
| L3 | **A protocol version gate, not a drain.** `OWNER_FILE_REQUESTS_PROTOCOL_VERSION = 2`. The supervisor bumps its `OWNER_PROTOCOL_VERSION` to 2 in the same change that handles `file_requests`. The server delivers file requests only to an owner whose stored `ownerProtocolVersion` is 2 or more; an older owner is answered from the snapshot with `fallback_reason: "owner_too_old"`. `OWNER_MINIMUM_PROTOCOL_VERSION` stays 1. | An owner lives at most 50 minutes, so skew is bounded; the gate is two comparisons, not a fork of behavior. |
| L4 | **Provenance on every file response**: `source` (`live` or `snapshot`), `as_of` (live: the time of the answer; snapshot: `published_at`), `stale` (a live computer exists whose disk may differ from this answer), `fallback_reason` (null unless a live attempt was skipped or failed), and for `owner_warming` a `retry_after_ms`. A computer that is off answers `source: "snapshot"`, `stale: false`: the snapshot is the truth. | W17. The UI needs exactly three states: live, saved copy, saved copy while the computer is on. |
| L5 | **Editing needs a live read.** `editable` is true only when the content response is `source: "live"`, the file is UTF-8 text, fully loaded (`truncated: false`), not masked unless revealed, and at most 256 KiB. The UI never offers an editor on a snapshot answer. A write is accepted only when the computer is live. A write while the computer is off is refused with 409 `computer_not_live` (open question Q1). | W15. |
| L6 | **The panel signals with a watch ping**, `POST .../files/watch` `{ open: true }` every 15 seconds while the Files tab is visible, and `{ open: false }` when it is hidden or closed. The server stores `interactiveUntilAt` on the computer record (now + 45 s for `open: true`, now for `open: false`). Every queued file request also sets it. | W2. The poll request stays unchanged; the server answers the pace. |
| L7 | **The interactive pace is 1000 ms**, not the design's 500 ms: `OWNER_POLL_INTERACTIVE_MILLISECONDS = 1000`. While `interactiveUntilAt` is in the future, `next_poll_ms = min(normal pace, 1000)`, in the states that can serve files (`idle`, `serving`, `publishing`, `draining`). | W3: it is the same as the first-minute idle tier, costs about 0.7 cents an hour while a panel is open, and makes the average pickup 0.5 seconds. Q3 lets the owner choose 500. |
| L8 | **One fixed result route**: `POST /orgs/{t}/host/owner/file-results`, the operation id in the body. It is added to `OWNER_COMPUTER_ROUTES`. | W5. |
| L9 | **A request has a delivery state.** `pending` (queued) becomes `delivered` (the poll handed it to the owner, a conditional write), `done` (result recorded) or `abandoned` (the Front Door gave up while it was still `pending`, a conditional write). An abandoned request is never delivered. For a delivered write the Front Door waits a further 7 seconds and then answers 504 `outcome_unknown`; the late result is still recorded and still audited. A delivered read that times out falls back to the snapshot. | W6. This is the dispatch lifecycle of OWNER_SUPERVISOR_PROTOCOL 6.3 applied to files. |
| L10 | **Rows are deleted by the code that reads them; TTL is a backstop.** The Front Door deletes a result item after it has read it. An abandoned item loses its `request` and `result` attributes in the same conditional update. `expires_at` (120 seconds after queueing) only bounds what a crash leaves behind, and **every reader treats an item past its `expires_at` as absent**. | W4. |
| L11 | **The idle stop is vetoed by a pending or delivered file request** (veto `file_operation_pending`), judged and approved with the same compare-and-set trick as a dispatch: the computer record carries `fileOperationId`, the id of the last queued request; the approval is conditional on it being unchanged. Queueing a request is conditional on the owner being live and no stop being approved. An approval and a queued request cannot both win. `lifetime` and `unhealthy` stops are not vetoed (the supervisor finishes the operation in flight and answers the rest `owner_stopping`). | W7. Mirrors OWNER_SUPERVISOR_PROTOCOL 5.4. |
| L12 | **A file operation is activity.** When one finishes, an idle supervisor restarts its idle clock. An open panel alone is not activity (open question Q2); only operations are. | W7. |
| L13 | **A successful write schedules the quiet publish**: the supervisor sets its next publish check to at most 30 seconds from the write if it is idle or publishing, and at the next gap if a child runs. The response says `backed_up: false` so the UI can say the copy on the computer is not yet in the saved copy. | W8. Q11 asks whether to relax C14 for edits. |
| L14 | **The Front Door marks the disk dirty before it queues a write** (`markComputerDiskDirty`) and refuses a write when `hydrateRequired` is true. | W9. A spurious dirty flag costs one index scan; a missing one loses an edit silently. |
| L15 | **The helper gets four bounded operations**: `list` (scans at most 20,000 names, returns at most 2,000 entries), `stat`, `read` (a range, at most 256 KiB, of a regular file of at most 8 MiB; hashes the whole file) and `write` (UTF-8 text up to 256 KiB, atomic, with a precondition). Opening is `O_NONBLOCK` and `fstat` must say regular file, so a FIFO or a device is `not_a_file`, not a hang. Each operation has a 6 second timeout enforced by the supervisor. | W10, W24. The 8 MiB cap is below the snapshot's 50 MiB; Q6. |
| L16 | **Writes are atomic and resolve links first.** The helper resolves the final location (following every link, as it does today), refuses it if outside the workspace, and writes a temporary file with a random name in the **resolved** directory, `fsync`s, `fchmod`s to the old mode (or 0664), compares the precondition once more and `rename`s it into place. A create uses `link` then `unlink`, which fails if the name exists. A link is therefore written through and stays a link. After the rename the helper re-hashes the file it replaced; if that differs from the hash the caller expected (a concurrent in-place write won the sub-millisecond window), it keeps the replaced bytes as a sibling `<name>.chatticus-replaced-<8 hex>` and reports `kept_as`. The Pi `write_workspace` tool takes the same `write` path with no precondition: one path. | W10, W21. The in-place writer of Pi and of the shell is why the post-check exists. |
| L17 | **File operations and the sweep exclude each other.** The supervisor's file runner has `pause()` (waits for running helpers, queues new requests) and `stopAccepting()` (waits for running helpers, answers new requests `owner_stopping`). The sweep after a child exit runs between `pause()` and `resume()`; the stop sequence calls `stopAccepting()` before it kills the child and sweeps. | W11. |
| L18 | **One list of secret names**, in `host-protocol/src/live-file-rules.ts`, imported by the snapshot service, the helper and the Front Door. It is Phase 1's list plus `.git-credentials`. Masking is decided by the **helper on the resolved path** for a live read (so a link named `config.txt` to `.env` is masked) and by the snapshot service on the path and the link target, as today. A reveal is `POST .../files/reveal` (it has a side effect, so not a `GET`), for both sources, and is audited. | W12. |
| L19 | **The publish and hydrate records stop overwriting the record.** `recordHostSnapshotPublished` and `recordHostHydrated` become targeted updates (`SET snapshot_*`, `disk_dirty`, `hydrate_required`). Part A1 does this before it adds the fields. | W13. |
| L20 | **A test holds the item size.** A maximal read result (256 KiB of binary, base64) as a table item must be under 380,000 bytes. A write carries UTF-8 text only. | W14. |
| L21 | **Audit: intent first, outcome by the result route.** The Front Door writes the record (`outcome: "pending"`) **before** it queues the request, and fails closed (503 `audit_unavailable`, nothing queued) if it cannot. The result route finalizes the record when a result arrives, even after the waiting request gave up. A record still `pending` after 120 seconds is read as `unknown`. The Front Door computes `sha256_after` from the bytes it sent; the owner's reported hashes are recorded as reported and a mismatch is flagged `integrity_mismatch`. The record holds no file content. | W16. |
| L22 | **Rate and pressure limits.** Per user per minute: 240 reads (list, stat, content), 30 writes, 10 reveals, 12 watch pings. Per computer: at most 16 open requests (`too_busy`, 429). Per poll: at most 4 requests delivered. The counters are bucketed items with `expires_at`, the pattern of `incrementOrganizationCreationAttempts`, generalized into one store method. | W18. |
| L23 | **`.git` is refused twice.** The Front Door refuses any lexical path with a `.git` segment (403 `path_refused`, audited); the helper refuses any **resolved** path with a `.git` segment when the request says so (`refuseGitSegments`, set by every live request, not set by the Pi tools: their behavior does not change). It is a guard against a click, not a privilege boundary. | W22. |
| L24 | **Writes and reveals need a user principal** (`kind: "user"`, a user id) of an enabled organization. The audit record carries the user id from the principal, never from the body. The 30 second membership cache is accepted and stated. | W23. |
| L25 | **The owner is not trusted for the trail or for policy.** Masking is also applied by the Front Door before it hands content to the browser when the owner reports a secret-looking `resolved_path` for a request that was not a reveal. The audit key family and the file-operation key family are outside both owner role policies; the `owner_role_policy.feature` scenarios prove it. | W25. |
| L26 | **Status codes keep the design's 409.** A failed `If-Match` is 409 `precondition_failed` with `current_sha256`, not RFC 9110's 412, because the design and the web app already speak 409 for conflicts and the client is first party. A missing precondition is 428. | Consistency. |
| L27 | **A Front Door wait is 8 seconds, and is skipped when it cannot succeed.** `expected pickup = max(0, lastHeartbeatAt + cadence - now)` where `cadence = ownerPollCadence(pollState, idleSeconds)`. If it is more than 7 seconds, the Front Door does not queue a request; it sets the interactive window, answers from the snapshot with `fallback_reason: "owner_warming"` and `retry_after_ms = expected pickup`, and the panel asks again then. For a write the Front Door answers 503 `owner_warming` with the same `retry_after_ms` and queues nothing. | W2. A first look at a long-idle computer answers at once instead of after 8 seconds. |
| L28 | **A live "not found" is an answer.** Owner errors that describe the file (`not_found`, `not_a_file`, `not_a_directory`, `file_too_large`, `outside_workspace`) are returned as such and never replaced by the snapshot, which may still hold a file deleted since. Only failures of the channel (`owner_timeout`, `helper_timeout`, `helper_failed`, `io_error`, `owner_busy`, `owner_stopping`, `expired`) make a read fall back. | A stale fallback must not resurrect a deleted file. |
| L29 | **Reading is not audited, writing and revealing are.** Refused writes (conflict, `path_refused`, size) are audited too; requests refused before authorization or by the rate limit are logged only. | D14 names edits and reveals. |

## 4. Constants

All in `host-protocol/src/live-files.ts` unless stated. Tests inject clocks; nothing is read
from the environment.

| Constant | Value | Used by |
| --- | --- | --- |
| `OWNER_FILE_REQUESTS_PROTOCOL_VERSION` (`supervisor.ts`) | 2 | server gate (L3) |
| `OWNER_POLL_INTERACTIVE_MILLISECONDS` (`supervisor.ts`) | 1000 | server cadence (L7) |
| `LIVE_FILE_WAIT_MILLISECONDS` | 8000 | Front Door wait; also the largest `expires_in_ms` |
| `LIVE_FILE_RESULT_CHECK_MILLISECONDS` | 250 | Front Door wait loop |
| `LIVE_FILE_OUTCOME_GRACE_MILLISECONDS` | 7000 | extra wait for a delivered write |
| `LIVE_FILE_OPERATION_TTL_SECONDS` | 120 | `expires_at` backstop (L10) |
| `LIVE_FILE_INTERACTIVE_WINDOW_SECONDS` | 45 | `interactiveUntilAt` after a ping or a request |
| `LIVE_FILE_WATCH_INTERVAL_SECONDS` | 15 | web ping interval |
| `LIVE_FILE_MAX_REQUESTS_PER_POLL` | 4 | poll response |
| `LIVE_FILE_MAX_OPEN_OPERATIONS` | 16 | per computer (L22) |
| `LIVE_FILE_MAX_CONCURRENT_HELPERS` | 2 | supervisor |
| `LIVE_FILE_MAX_QUEUED_REQUESTS` | 8 | supervisor, beyond it `owner_busy` |
| `LIVE_FILE_HELPER_TIMEOUT_MILLISECONDS` | 6000 | supervisor (L15) |
| `LIVE_FILE_MEMORY_REFUSE_PERCENT` | 90 | supervisor, beyond it `owner_busy` |
| `LIVE_FILE_CONTENT_MAX_BYTES` | 262144 | read range, write body |
| `LIVE_FILE_READ_MAX_FILE_BYTES` | 8388608 | helper read (L15) |
| `LIVE_FILE_LISTING_MAX_ENTRIES` | 2000 | list result |
| `LIVE_FILE_LISTING_SCAN_MAX_NAMES` | 20000 | helper list |
| `LIVE_FILE_STDOUT_MAX_BYTES` | 1048576 | supervisor reading the helper |
| `LIVE_FILE_PATH_MAX_CHARACTERS` (`live-file-rules.ts`) | 1024 | all paths (existing value) |
| `LIVE_FILE_RATE_WINDOW_SECONDS` | 60 | counters |
| `LIVE_FILE_READ_RATE`, `_WRITE_RATE`, `_REVEAL_RATE`, `_WATCH_RATE` | 240, 30, 10, 12 | per user per window |
| `LIVE_FILE_AUDIT_RETENTION_DAYS` | 90 | audit `expires_at` (D14) |
| `LIVE_FILE_PENDING_AUDIT_UNKNOWN_SECONDS` | 120 | reading a `pending` record |
| `LIVE_FILE_PI_CHANGED_WINDOW_SECONDS` | 60 | web warning |
| `LIVE_FILE_EDIT_PROBE_SECONDS` | 5 | web `stat` probe while editing |
| `LIVE_FILE_RETRY_AFTER_MIN/MAX_MILLISECONDS` | 1000 / 10000 | `retry_after_ms` clamp |
| `LIVE_FILE_ERROR_STATUS` | code to status map (section 6.3) | server, tests |
| `LIVE_FILE_OWNER_ERROR_CODES` | owner code list (section 5.4) | supervisor, helper, server |

Not changed: `DEFAULT_HEARTBEAT_TIMEOUT_SECONDS` = 30, `OWNER_POLL_*` tiers,
`OWNER_IDLE_TIMEOUT_SECONDS`, `OWNER_POLL_SILENCE_FENCE_SECONDS`. The 8 second wait fits
inside the 25 second fence only because the wait is in the Front Door, not the owner.

## 5. Wire schemas

Two new files in `host-protocol/` and four small edits to `host-protocol/src/supervisor.ts`.
`package.json` exports `./live-files` and `./live-file-rules`. `live-file-rules.ts` imports
nothing at all (the file helper bundle must stay free of `zod` and of anything that could
carry a credential); `live-files.ts` imports `zod` and `live-file-rules.ts`;
`supervisor.ts` imports `live-files.ts`, never the other way round.

### 5.1 `host-protocol/src/live-file-rules.ts` (no imports)

```ts
/** The root of every path a person or the Front Door names. */
export const LIVE_WORKSPACE_ROOT = "/workspace";

/** The longest path, in characters, any file route accepts. */
export const LIVE_FILE_PATH_MAX_CHARACTERS = 1024;

export type LivePathProblem = "empty" | "too_long" | "nul" | "not_absolute" | "dot_dot" | "outside_workspace";

/**
 * Why a path is not a workspace path, or null when it is one. Lexical only: it follows no link.
 * The path must be absolute, at most 1024 characters, hold no NUL and no ".." segment, and after
 * normalisation be "/workspace" or start with "/workspace/".
 */
export function livePathProblem(raw: string): LivePathProblem | null;

/** The normalised form ("/workspace/a/b", no trailing slash, no "." segment). Precondition: livePathProblem(raw) === null. */
export function normalizeLivePath(raw: string): string;

/** Whether any segment of a normalised path is exactly ".git" (a file or a directory). */
export function livePathHasGitSegment(normalized: string): boolean;

/**
 * Whether a path looks like it holds a secret. Case-insensitive on the segments. True for a file named .env or .env.*,
 * *.pem, *.key, *.p12, *.pfx, id_rsa*, id_ed25519*, credentials, .netrc, .npmrc, .git-credentials, and for any file under
 * a directory named .ssh or .aws. It is the Phase 1 list plus .git-credentials.
 */
export function looksLikeSecretFile(path: string): boolean;

/** True when the first 8 KiB holds a NUL or is not valid UTF-8. */
export function looksBinary(bytes: Uint8Array): boolean;

/** Drop an incomplete UTF-8 sequence from the end of a byte range. */
export function trimToCharacterBoundary(bytes: Uint8Array): Uint8Array;

/** The number of bytes of the UTF-8 encoding of a string. */
export function utf8ByteLength(text: string): number;
```

`conversation/src/snapshot/files.ts` deletes its private copies (`indexPathOf` keeps its
index-path mapping on top of `livePathProblem`, `looksLikeSecretFile`, `looksBinary`,
`trimToCharacterBoundary`) and imports these. That is a behavior-preserving move plus
`.git-credentials`; the existing scenarios in `computer_snapshot_index.feature` stay green.

### 5.2 `host-protocol/src/live-files.ts`

```ts
import { z } from "zod";
import { LIVE_FILE_PATH_MAX_CHARACTERS, livePathProblem, utf8ByteLength } from "./live-file-rules.ts";

export const LIVE_FILE_WAIT_MILLISECONDS = 8000;
export const LIVE_FILE_RESULT_CHECK_MILLISECONDS = 250;
export const LIVE_FILE_OUTCOME_GRACE_MILLISECONDS = 7000;
export const LIVE_FILE_OPERATION_TTL_SECONDS = 120;
export const LIVE_FILE_INTERACTIVE_WINDOW_SECONDS = 45;
export const LIVE_FILE_WATCH_INTERVAL_SECONDS = 15;
export const LIVE_FILE_MAX_REQUESTS_PER_POLL = 4;
export const LIVE_FILE_MAX_OPEN_OPERATIONS = 16;
export const LIVE_FILE_MAX_CONCURRENT_HELPERS = 2;
export const LIVE_FILE_MAX_QUEUED_REQUESTS = 8;
export const LIVE_FILE_HELPER_TIMEOUT_MILLISECONDS = 6000;
export const LIVE_FILE_MEMORY_REFUSE_PERCENT = 90;
export const LIVE_FILE_CONTENT_MAX_BYTES = 262144;
export const LIVE_FILE_READ_MAX_FILE_BYTES = 8388608;
export const LIVE_FILE_LISTING_MAX_ENTRIES = 2000;
export const LIVE_FILE_LISTING_SCAN_MAX_NAMES = 20000;
export const LIVE_FILE_STDOUT_MAX_BYTES = 1048576;
export const LIVE_FILE_RATE_WINDOW_SECONDS = 60;
export const LIVE_FILE_READ_RATE = 240;
export const LIVE_FILE_WRITE_RATE = 30;
export const LIVE_FILE_REVEAL_RATE = 10;
export const LIVE_FILE_WATCH_RATE = 12;
export const LIVE_FILE_AUDIT_RETENTION_DAYS = 90;
export const LIVE_FILE_PENDING_AUDIT_UNKNOWN_SECONDS = 120;
export const LIVE_FILE_RETRY_AFTER_MIN_MILLISECONDS = 1000;
export const LIVE_FILE_RETRY_AFTER_MAX_MILLISECONDS = 10000;

const identifier = z.string().min(1).max(256);
const timestamp = z.iso.datetime();
const generation = z.number().int().positive();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const mode = z.string().regex(/^[0-7]{3,4}$/);

/** A path under /workspace, lexically valid. The same rules as livePathProblem; the issue message names the problem. */
export const livePathSchema = z.string().max(LIVE_FILE_PATH_MAX_CHARACTERS).superRefine((value, context) => {
	const problem = livePathProblem(value);
	if (problem !== null) context.addIssue({ code: "custom", message: `not a workspace path: ${problem}` });
});

/** UTF-8 text a person may save: at most 256 KiB, no NUL. */
export const liveFileTextSchema = z.string().refine(
	(text) => utf8ByteLength(text) <= LIVE_FILE_CONTENT_MAX_BYTES && !text.includes("\u0000"),
	{ message: "content must be UTF-8 text of at most 262144 bytes with no NUL" },
);

/** One directory entry, the same shape for a live listing and a snapshot listing. */
export const liveFileEntrySchema = z
	.object({
		name: z.string().min(1).max(255),
		path: livePathSchema,
		kind: z.enum(["file", "directory", "symlink"]),
		size: z.number().int().nonnegative().nullable(),
		mode: mode.nullable(),
		sha256: sha256Hex.nullable(),
		link_target: z.string().max(4096).nullable(),
		modified_at: timestamp.nullable(),
	})
	.strict();

/** What a write must find on the disk. "if_match" replaces a file with this hash; "if_none_match" creates a file that must not exist. */
export const liveFileWritePreconditionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("if_match"), sha256: sha256Hex }).strict(),
	z.object({ type: z.literal("if_none_match") }).strict(),
]);

const requestBase = {
	operation_id: identifier,
	path: livePathSchema,
	expires_in_ms: z.number().int().min(0).max(LIVE_FILE_WAIT_MILLISECONDS),
};

/**
 * One file request the poll hands to the owner. Not strict: a newer server may add a field an older owner ignores.
 * `expires_in_ms` is relative to the moment the owner received the answer; the owner measures it with its own clock and
 * answers `expired`, without touching the disk, if it cannot start the operation in that time.
 */
export const ownerFileRequestSchema = z.discriminatedUnion("kind", [
	z.object({ ...requestBase, kind: z.literal("list"), max_entries: z.number().int().min(1).max(LIVE_FILE_LISTING_MAX_ENTRIES) }),
	z.object({ ...requestBase, kind: z.literal("stat") }),
	z.object({
		...requestBase,
		kind: z.literal("read"),
		offset: z.number().int().min(0),
		length: z.number().int().min(1).max(LIVE_FILE_CONTENT_MAX_BYTES),
		mask: z.boolean(),
	}),
	z.object({ ...requestBase, kind: z.literal("write"), content: liveFileTextSchema, precondition: liveFileWritePreconditionSchema }),
]);

/** Why an owner could not carry out a request. */
export const LIVE_FILE_OWNER_ERROR_CODES = [
	"not_found",
	"not_a_file",
	"not_a_directory",
	"outside_workspace",
	"permission_denied",
	"file_too_large",
	"already_exists",
	"precondition_failed",
	"parent_missing",
	"not_text",
	"path_refused",
	"expired",
	"owner_stopping",
	"owner_busy",
	"helper_failed",
	"helper_timeout",
	"io_error",
] as const;
export const liveFileOwnerErrorCodeSchema = z.enum(LIVE_FILE_OWNER_ERROR_CODES);

const listResult = z
	.object({
		kind: z.literal("list"),
		resolved_path: livePathSchema,
		entries: z.array(liveFileEntrySchema).max(LIVE_FILE_LISTING_MAX_ENTRIES),
		truncated: z.boolean(),
	})
	.strict();

const statResult = z.object({ kind: z.literal("stat"), entry: liveFileEntrySchema }).strict();

const readResult = z
	.object({
		kind: z.literal("read"),
		resolved_path: livePathSchema,
		size: z.number().int().nonnegative(),
		sha256: sha256Hex,
		mode,
		modified_at: timestamp,
		encoding: z.enum(["utf8", "base64"]),
		binary: z.boolean(),
		offset: z.number().int().nonnegative(),
		length: z.number().int().min(0).max(LIVE_FILE_CONTENT_MAX_BYTES),
		content: z.string(),
		truncated: z.boolean(),
		masked: z.boolean(),
	})
	.strict()
	.refine((result) => !result.masked || (result.content === "" && result.length === 0), { message: "a masked read carries no content" });

const writeResult = z
	.object({
		kind: z.literal("write"),
		resolved_path: livePathSchema,
		created: z.boolean(),
		size: z.number().int().nonnegative(),
		sha256_before: sha256Hex.nullable(),
		sha256_after: sha256Hex,
		modified_at: timestamp,
		kept_as: livePathSchema.optional(),
	})
	.strict();

/** The owner's answer to one request: the result, or the code of the error that stopped it. */
export const liveFileOutcomeSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("ok"), result: z.discriminatedUnion("kind", [listResult, statResult, readResult, writeResult]) }).strict(),
	z
		.object({
			status: z.literal("error"),
			code: liveFileOwnerErrorCodeSchema,
			message: z.string().max(500),
			current_sha256: sha256Hex.nullable().optional(),
		})
		.strict(),
]);

/** POST /orgs/{tenant}/host/owner/file-results: the supervisor posts the answer to one request. */
export const ownerFileResultRequestSchema = z
	.object({ owner_id: identifier, generation, operation_id: identifier, outcome: liveFileOutcomeSchema })
	.strict();

/** The answer: the result is recorded (also when it repeats one already recorded, byte for byte). */
export const ownerFileResultResponseSchema = z.object({ recorded: z.literal(true) });

/** Why a member-facing file response came from the snapshot although a live computer exists. */
export const liveFileFallbackReasonSchema = z.enum([
	"owner_timeout",
	"owner_error",
	"owner_not_ready",
	"owner_too_old",
	"owner_warming",
	"owner_stopping",
]);

/** The fields every member-facing list, stat and content response carries. */
export const liveFileProvenanceShape = {
	source: z.enum(["live", "snapshot"]),
	as_of: timestamp.nullable(),
	stale: z.boolean(),
	fallback_reason: liveFileFallbackReasonSchema.nullable(),
	retry_after_ms: z.number().int().min(LIVE_FILE_RETRY_AFTER_MIN_MILLISECONDS).max(LIVE_FILE_RETRY_AFTER_MAX_MILLISECONDS).optional(),
};

export const liveFileListingResponseSchema = z.object({
	...liveFileProvenanceShape,
	path: livePathSchema,
	truncated: z.boolean(),
	entries: z.array(liveFileEntrySchema).max(LIVE_FILE_LISTING_MAX_ENTRIES),
});

export const liveFileStatResponseSchema = z.object({ ...liveFileProvenanceShape, entry: liveFileEntrySchema });

export const liveFileContentResponseSchema = z.object({
	...liveFileProvenanceShape,
	path: livePathSchema,
	size: z.number().int().nonnegative(),
	sha256: sha256Hex,
	encoding: z.enum(["utf8", "base64"]),
	binary: z.boolean(),
	offset: z.number().int().nonnegative(),
	length: z.number().int().nonnegative(),
	content: z.string(),
	truncated: z.boolean(),
	masked: z.boolean(),
	revealed: z.boolean(),
	editable: z.boolean(),
	modified_at: timestamp.nullable(),
});

/** PUT /orgs/{tenant}/computer/files/content?path=  with If-Match: "<sha256>" or If-None-Match: *  */
export const liveFileWriteBodySchema = z.object({ content: liveFileTextSchema }).strict();

export const liveFileWriteResponseSchema = z.object({
	source: z.literal("live"),
	as_of: timestamp,
	path: livePathSchema,
	created: z.boolean(),
	size: z.number().int().nonnegative(),
	sha256: sha256Hex,
	previous_sha256: sha256Hex.nullable(),
	modified_at: timestamp,
	kept_as: livePathSchema.nullable(),
	backed_up: z.literal(false),
});

/** POST /orgs/{tenant}/computer/files/reveal */
export const liveFileRevealBodySchema = z
	.object({
		path: livePathSchema,
		offset: z.number().int().min(0).optional(),
		length: z.number().int().min(1).max(LIVE_FILE_CONTENT_MAX_BYTES).optional(),
	})
	.strict();

/** POST /orgs/{tenant}/computer/files/watch: the Files panel is open (true) or closed (false). */
export const liveFileWatchBodySchema = z.object({ open: z.boolean() }).strict();

export const liveFileWatchResponseSchema = z.object({
	state: z.enum(["off", "starting", "live"]),
	interactive_until: timestamp.nullable(),
	poll_interval_ms: z.number().int().min(250).max(60000).nullable(),
});

/** The body of every member-facing file refusal (Phase 1 shape, extended). */
export const liveFileErrorSchema = z.object({
	error: z.string(),
	message: z.string(),
	current_sha256: sha256Hex.nullable().optional(),
	retry_after_ms: z.number().int().positive().optional(),
	kept_as: livePathSchema.optional(),
});

export type OwnerFileRequest = z.infer<typeof ownerFileRequestSchema>;
export type LiveFileOutcome = z.infer<typeof liveFileOutcomeSchema>;
export type OwnerFileResultRequest = z.infer<typeof ownerFileResultRequestSchema>;
export type LiveFileEntry = z.infer<typeof liveFileEntrySchema>;
export type LiveFileOwnerErrorCode = z.infer<typeof liveFileOwnerErrorCodeSchema>;
export type LiveFileFallbackReason = z.infer<typeof liveFileFallbackReasonSchema>;
export type LiveFileWriteResponse = z.infer<typeof liveFileWriteResponseSchema>;
```

A schema test (`conversation/test/live-files-protocol-schema.test.ts`) must prove at least:
the largest read result (a 262144 byte range of binary, base64) serialized as a table item
is under 380,000 bytes (L20); a write of 262144 bytes of multi-byte text passes and one
byte more fails; a path with `..`, a NUL, a relative path and a path outside `/workspace`
fails; a masked read result with content fails; a request with an unknown field fails and a
poll response with an unknown field passes.

### 5.3 Edits to `host-protocol/src/supervisor.ts`

```ts
/** The first protocol version whose owner understands file_requests in the poll response. */
export const OWNER_FILE_REQUESTS_PROTOCOL_VERSION = 2;

/** Milliseconds between polls while a Files panel is open, in the states that can serve a file request. */
export const OWNER_POLL_INTERACTIVE_MILLISECONDS = 1000;

// ownerErrorCodeSchema gains "operation_closed"; OWNER_ERROR_STATUS maps it to 409.
// ownerStopVetoReasonSchema gains "file_operation_pending".
// ownerPollResponseSchema gains, beside dispatches:
//   file_requests: z.array(ownerFileRequestSchema).max(LIVE_FILE_MAX_REQUESTS_PER_POLL).default([]),
// The two refinements (drain_reason, no dispatch while draining) are unchanged; file_requests are allowed while draining.
```

`OWNER_PROTOCOL_VERSION` stays 1 in F0. **Part C** changes it to 2 in the same pull request that
makes the supervisor handle `file_requests` (L3). `ownerPollRequestSchema` is unchanged.

### 5.4 Owner error codes

`operation_closed` (409): the request was abandoned, expired, answered already with a
different result, never delivered to this owner, or belongs to another computer. The
supervisor drops the operation on it. The existing rules for 401, 403 and 409 `stale_poll`
of OWNER_SUPERVISOR_PROTOCOL 9.5 apply to the new route unchanged: a 401 or a superseding 403 ends the supervisor.

## 6. Routes

### 6.1 Owner routes (audience `computer-owner`)

| Method and path | Request | Response (200) | Refusals |
| --- | --- | --- | --- |
| `POST /orgs/{t}/host/owner/poll` (changed) | `ownerPollRequestSchema` (unchanged) | `ownerPollResponseSchema` with `file_requests` | as before |
| `POST /orgs/{t}/host/owner/file-results` (new) | `ownerFileResultRequestSchema` | `ownerFileResultResponseSchema` | 401, 403 as every owner route; 409 `operation_closed`; 422 `invalid_request`; 503 when the audit or request store write fails (the supervisor retries) |
| `POST /orgs/{t}/host/owner/stop-request` (changed) | unchanged | `ownerStopResponseSchema`, a new veto `file_operation_pending` | as before |

The result route is added to `OWNER_COMPUTER_ROUTES`. Authentication is section 5.1 of
OWNER_SUPERVISOR_PROTOCOL, unchanged: signature, audience, tenant, computer, generation,
live owner. Additionally the handler requires that the request item names this owner id,
this computer and this generation (409 `operation_closed` otherwise).

### 6.2 Member routes (audience `user`)

All under `/orgs/{tenant_id}/computer/files`, resolved by `resolveUserPrincipal`
(`http/user-principal.ts`) exactly as the Phase 1 routes are. Every response carries
`X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`; content responses
add `Vary: Authorization`. A refusal of the principal is the Phase 1 `{ "detail": ... }` 403.

| Method and path | Request | Response (200) | Notes |
| --- | --- | --- | --- |
| `GET ?path=` | `path` | `liveFileListingResponseSchema` | live or snapshot (7.2) |
| `GET /stat?path=` | `path` | `liveFileStatResponseSchema` | live: the entry as it is, without following a link and without a hash |
| `GET /content?path=&offset=&length=` | as Phase 1 | `liveFileContentResponseSchema`, header `ETag: "<sha256>"` | masked: `masked: true`, no content |
| `PUT /content?path=` | `liveFileWriteBodySchema`; header `If-Match: "<sha256>"` **or** `If-None-Match: *` | `liveFileWriteResponseSchema`, header `ETag` | 7.3 |
| `POST /reveal` | `liveFileRevealBodySchema` | `liveFileContentResponseSchema` with `masked: false, revealed: true`; `Cache-Control: no-store` | audited; both sources |
| `POST /watch` | `liveFileWatchBodySchema` | `liveFileWatchResponseSchema` | 7.5 |

Header rules for `PUT`: exactly one of the two preconditions (both or neither: 428
`precondition_required`); `If-Match` takes one strong quoted 64 hex digit value (`"abc..."`;
`*`, a list, a weak `W/` value or a malformed value: 400 `invalid_body`); `If-None-Match` takes
`*` only. CloudFront forwards both headers on `/api*` (`OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER`,
`allowedMethods: ALLOW_ALL`, `infra/lib/web-stack.ts:139-152`) and the web app and the API share an origin, so there is no
CORS to configure. ASSUMPTION: CloudFront does not strip `If-Match` or alter `ETag`; Part A2 checks it on development.

### 6.3 Member error codes and statuses

The body is `{ "error": code, "message": text }` plus `current_sha256`, `retry_after_ms` or
`kept_as` where the code says so. `LIVE_FILE_ERROR_STATUS` is this table.

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_path` | 400 | not a workspace path (lexical) |
| `invalid_range` | 400 | `offset` or `length` not a non-negative integer (existing) |
| `invalid_body` | 400 | body or precondition header malformed |
| `path_refused` | 403 | a `.git` segment, lexical or resolved; audited |
| `not_found` | 404 | no such path (live answer, never replaced by the snapshot) |
| `parent_missing` | 404 | creating a file in a directory that does not exist |
| `no_snapshot` | 404 | existing: nothing published and no live owner |
| `already_exists` | 409 | `If-None-Match: *` on a path that exists |
| `precondition_failed` | 409 | `If-Match` hash differs; carries `current_sha256` |
| `computer_not_live` | 409 | a write needs a live owner able to serve it and there is none (off, starting, stopping, too old) |
| `snapshot_not_indexed` | 409 | existing |
| `content_too_large` | 413 | body over 256 KiB, refused before the owner is asked |
| `file_too_large` | 413 | live read over 8 MiB, or a write that would replace a file over 256 KiB |
| `range_too_large` | 413 | existing |
| `not_a_file`, `not_a_directory`, `too_many_symlinks`, `not_text` | 422 | existing, plus `not_text` for a write of text over a binary file |
| `precondition_required` | 428 | no precondition header |
| `rate_limited` | 429 | a user limit; carries `Retry-After` seconds |
| `too_busy` | 429 | the computer has 16 open requests |
| `corrupt_snapshot` | 500 | existing |
| `owner_error` | 502 | the helper failed (`helper_failed`, `io_error`) on a write |
| `audit_unavailable` | 503 | the audit record could not be written; nothing was queued |
| `snapshot_store_unavailable` | 503 | existing |
| `owner_warming` | 503 | a write when the owner will not poll within 7 seconds; nothing queued; carries `retry_after_ms` |
| `owner_timeout` | 504 | a write that was never delivered (nothing happened) or expired |
| `outcome_unknown` | 504 | a write was delivered and no result arrived; read the file again |

Owner error to member response, for the cases not in the table above: `outside_workspace`
and `permission_denied` become 403 `path_refused` (with the owner's message), `owner_stopping`
on a write becomes 409 `computer_not_live`, `owner_busy` becomes 429 `too_busy`, `expired`
becomes 504 `owner_timeout`, `helper_timeout` on a write becomes 504 `outcome_unknown` (the
rename may have happened), on a read it falls back. For reads, the channel failures of L28 fall back to the snapshot with
`fallback_reason` `owner_timeout` (no result in time or `helper_timeout`, `expired`),
`owner_error` (`helper_failed`, `io_error`, `owner_busy`) or `owner_stopping`.

## 7. Server behavior

### 7.1 Records

**Computer record** (`store/codecs/computer.ts`) gains two optional fields. Both are removed
with the other owner fields (`OWNER_ATTRIBUTE_NAMES`, `withoutOwner`) when an owner ends or a
generation is claimed, and both must be encoded and decoded or a `putComputer` drops them.

| Field (attribute) | Type | Written by | Meaning |
| --- | --- | --- | --- |
| `interactiveUntilAt` (`interactive_until_at`, epoch seconds) | date | watch ping, queueing a request | the owner polls at the interactive pace until then; the poll queries the request partition only until then |
| `fileOperationId` (`file_operation_id`) | string | queueing a request | the id of the last queued request; the idle stop approval is conditional on it (L11) |

**Request item** (new codec `store/codecs/live-file-operation.ts`): partition
`{tenant}#computer#fileops`, sort key `op#{operation_id}`; `operation_id` is `fop-` plus an id from `deps.ids`.

| Attribute | Type | Meaning |
| --- | --- | --- |
| `operation_id`, `tenant_id`, `computer_id`, `user_id` | S | who asked, for which computer |
| `owner_id`, `generation` | S, N | the owner the request was queued for |
| `kind` | S | `list`, `stat`, `read`, `write` |
| `status` | S | `pending`, `delivered`, `done`, `abandoned` |
| `request` | S | the request as the owner receives it, JSON, without `expires_in_ms`; removed when abandoned or when the result is read |
| `queued_at`, `delivered_at` | S | ISO times; `queued_at` has second precision of the injected clock |
| `delivered_sequence` | N | the poll sequence that delivered it |
| `outcome` | S | `liveFileOutcomeSchema` JSON; set when `done`; removed when the Front Door reads it |
| `waiter_gone` | BOOL | the waiting handler gave up while the status was `delivered`; the result route then deletes the item |
| `expires_at` | N | queue time + 120 s; the TTL backstop (L10) |

The per-turn role has no access to either partition (`owner-role-policy.json` `MessagingWritable` lists exactly `computer#actions` and `computer#record`); the supervisor role has no DynamoDB access at all.

**Audit item** (new codec `store/codecs/file-audit.ts`): partition `{tenant}#computer#audit`,
sort key `at#{epoch milliseconds, 13 digits}#{operation_id}`.

| Attribute | Type | Meaning |
| --- | --- | --- |
| `tenant_id`, `computer_id`, `user_id`, `operation_id` | S | `user_id` from the principal |
| `operation` | S | `write` (replace), `create`, `reveal` |
| `path` | S | the normalised path the person named |
| `resolved_path` | S | as reported by the owner, absent until the result arrives |
| `source` | S | `live` or `snapshot` (a reveal from the snapshot) |
| `outcome` | S | `pending`, `ok`, `conflict`, `refused`, `failed`, `unknown` |
| `error_code` | S | the owner or member code for a non-`ok` outcome |
| `sha256_before` | S | for a replace, the hash the person expected (`If-Match`); owner-reported value in `sha256_before_reported` |
| `sha256_after` | S | computed by the Front Door from the bytes it sent; the owner's in `sha256_after_reported` |
| `bytes` | N | size of the content sent |
| `secret_name` | BOOL | the path looked like a secret |
| `revealed` | BOOL | true for a reveal |
| `kept_as` | S | when the helper kept a concurrently changed copy |
| `flags` | SS | `integrity_mismatch` when reported hashes disagree with computed ones |
| `at`, `finished_at` | S | ISO times |
| `expires_at` | N | `at` + 90 days (D14) |

No file content, no body, no token is ever stored. A reader treats a record past
`expires_at` as absent and a `pending` record older than 120 seconds as `unknown`.

**Rate counters**: partition `U#{user_id}` (the user partition of `dynamo-messaging-store.ts`),
sort key `file_rate#{class}#{bucket}`, attributes `attempt_count`, `expires_at`; the new store
method `incrementRateCounter(userId, name, now, windowSeconds)` returns the count, and
`incrementOrganizationCreationAttempts` is re-expressed through it (one implementation).

### 7.2 Reading: choosing live or snapshot

```
liveFileSourceOf(computer, worker, now) -> "live" | { snapshot, reason }
  computer is null or has no owner               -> snapshot, no reason, stale=false     (the computer is off)
  not liveOwnerOf(computer, worker, now, 30)     -> snapshot, no reason, stale=false     (heartbeat lapsed: treated as off)
  computer.ownerProtocolVersion < 2              -> snapshot, owner_too_old,  stale=true
  worker.pollState in {booting, hydrating}       -> snapshot, owner_not_ready, stale=true
  worker.pollState is stopping, or computer.ownerStopApprovedAt set  -> snapshot, owner_stopping, stale=true
  computer.hydrateRequired                       -> snapshot, owner_not_ready, stale=true
  else                                           -> live
```

Steps of a `GET` (list, stat, content), first failure wins:

1. `resolveUserPrincipal` (member of the path organization, organization enabled): else the
   Phase 1 refusal. 429 `rate_limited` from the read counter. `livePathProblem` (400).
2. `getComputer`, `getWorker(computer.ownerId)`, `liveFileSourceOf`.
3. Snapshot: the Phase 1 service, with the provenance fields added. A computer with no
   snapshot but a live owner never reaches here for a live-eligible state.
4. Live:
   1. `expected pickup` (L27). More than 7 seconds: set the interactive window (a conditional update of the record,
      owner still live), answer from the snapshot with `owner_warming` and `retry_after_ms`.
   2. Fewer than 16 open requests (a `Query ... Select COUNT` of the partition): else 429 `too_busy`.
   3. Queue the request in **one transaction**: `Update` the computer record
      (`SET interactive_until_at = :t, file_operation_id = :op`, condition `owner_id = :owner AND owner_generation = :g AND attribute_not_exists(owner_stop_approved_at)`)
      and `Put` the request item (`attribute_not_exists(pk)`, status `pending`, `expires_at`). A canceled transaction is
      treated as "the owner stopped": snapshot, `owner_stopping`.
   4. Wait: loop, strongly consistent `GetItem` of the request item every 250 ms, until `done` or 8 seconds on the injected clock.
   5. `done`: delete the item, map the outcome (6.3). A secret-looking `resolved_path` on a read that was not a
      reveal and not `masked` (an owner that did not mask) is masked here: content dropped, `masked: true` (L25).
   6. Timeout (8 seconds after queueing): one conditional update `pending -> abandoned` that removes `request` and `outcome`.
      Won: fall back to the snapshot with `owner_timeout`. Lost because the status is `delivered`: the owner has the
      request. A read does not wait longer: it sets `waiter_gone` on the item (conditional on `delivered`) and falls
      back to the snapshot. Lost because the status is `done`: read the outcome as in step 5.
5. `stale` is true for any snapshot answer whose `fallback_reason` is not null. A live answer has
   `source: "live"`, `stale: false`, `as_of` = the Front Door's clock at the answer.

`editable` (content only): `source === "live"` and `!masked` (or `revealed`) and `!binary` and `!truncated` and `size <= 262144`.

### 7.3 Writing: `PUT .../files/content`

First failure wins; the audit record exists from step 8 on.

1. Principal: `kind === "user"`, `userId !== null`, enabled organization (L24). 403 otherwise.
2. Write rate counter (429). Parse the precondition headers (428, 400). Parse the body with `liveFileWriteBodySchema` (400 `invalid_body`; a body over 256 KiB is 413 `content_too_large`, checked from `Content-Length` first and again after parsing).
3. `livePathProblem` (400). The normalised path has a `.git` segment: write the audit record with outcome `refused`, `error_code path_refused`, answer 403. (A refusal is audited, L29.)
4. `liveFileSourceOf` must be `live` and the owner's `pollState` not `stopping` (L2): else 409 `computer_not_live`. Not audited (nothing was attempted).
5. `computer.hydrateRequired`: 409 `computer_not_live`.
6. Fewer than 16 open requests (429 `too_busy`).
7. `expected pickup` (L27): too slow: set the interactive window and answer 503 `owner_warming` with `retry_after_ms`; nothing is queued and nothing is audited. The UI keeps the person's text and asks again at that time.
8. Write the audit record, `outcome: "pending"` (L21). If the write fails: 503 `audit_unavailable`, nothing queued.
9. `markComputerDiskDirty` (L14).
10. Queue the request (transaction of 7.2 step 4.3). Canceled: finalize the audit record `failed`/`owner_stopping`, answer 409 `computer_not_live`.
11. Wait (7.2 step 4.4). On `done` delete the item and map the outcome:
    * `ok` write: 200, `liveFileWriteResponseSchema`, `ETag: "<sha256_after>"`, `backed_up: false`.
    * error `precondition_failed` or `already_exists`: 409 with `current_sha256`.
    * the other owner errors per 6.3.
12. Timeout: `pending -> abandoned` conditional update. Won: 504 `owner_timeout`, nothing happened, the audit record is finalized `failed`. Lost because the status is `delivered`: wait up to 7 more seconds (`LIVE_FILE_OUTCOME_GRACE_MILLISECONDS`); still nothing: set `waiter_gone` on the item (conditional on `delivered`) and answer 504 `outcome_unknown`. The audit record stays `pending` and becomes `ok` or `failed` whenever the result route hears the owner.

The **result route** (7.4) finalizes the audit record. The waiting handler never writes the outcome, so
a late result is still recorded.

A create (`If-None-Match: *`) is audited as `create`; a replace as `write`.

### 7.4 The result route and the poll

`POST /host/owner/file-results` handler, after authentication (6.1):

1. Parse (422). `owner_id` and `generation` equal the principal's (403 `credential_mismatch`).
2. Read the item (consistent). Absent, past `expires_at`, other owner, other computer, other generation, status `abandoned` or `pending`: 409 `operation_closed`. Status `done`: if the stored outcome equals this one, 200 (idempotent); else 409.
3. The result's `kind` must equal the request's `kind` (422 `invalid_request`).
4. One conditional update `delivered -> done` setting `outcome`. Lost: re-read and treat as step 2. If the item has `waiter_gone`, the handler deletes the item after step 5 and does not keep the outcome (the content of a read nobody is waiting for is not stored).
5. Finalize the audit record (conditional on it existing): outcome from the result (`ok`, `conflict` for `precondition_failed` and `already_exists`, `refused` for `path_refused`, `failed` otherwise), `resolved_path`, `kept_as`, the reported hashes, and the `integrity_mismatch` flag when `sha256_after` reported differs from computed. A failure here: 503 (the supervisor retries; the update in step 4 is idempotent). For operations that carry no audit record (reads) there is no step 5.
6. 200 `{ "recorded": true }`.

In `pollOwner`, after "settle lost actions" and before "drain" (the order of 5.3 of the supervisor contract; `drain` is computed after), when `request.protocol_version >= 2`, the request state is `idle`, `serving`, `publishing` or `draining`, `computer.ownerStopApprovedAt` is unset and `computer.interactiveUntilAt > now`:

1. `Query` the partition for items with `status = pending` for this owner and generation, oldest first, limit 4, ignoring items past `expires_at`; plus the items with `status = delivered` and `delivered_sequence = request.sequence` (a repeated poll).
2. For each pending one, conditional update `pending -> delivered`, `delivered_at`, `delivered_sequence = request.sequence`, owner id. A lost update skips it.
3. Return them in `file_requests` with `expires_in_ms = max(0, 8000 - (now - queued_at))`. A request already past 8 seconds is not delivered (it is being abandoned).

Cadence: `next_poll_ms = ownerPollCadence(state, idleSeconds)`; if `interactiveUntilAt > now` and the state can serve files, `min(that, OWNER_POLL_INTERACTIVE_MILLISECONDS)` (L7). `ownerPollCadence` keeps its signature; the interactive clamp is a second function `ownerFilePanelPace`.

**Stop request.** `stopVeto` for `reason: "idle"` gains, after the parked work check: any non-expired item with status `pending` or `delivered` for this computer: veto `file_operation_pending`. `approveOwnerStop` gains a second guard, `attribute_not_exists(file_operation_id) OR file_operation_id = :seen`, where `:seen` is the value read when the predicate was judged; the existing three-attempt re-judge loop covers a lost race (L11).

### 7.5 Reveal and watch

**Reveal** (`POST /reveal`): steps 1, 2 (reveal counter), 3 of a `GET`, then the audit record
(`operation: "reveal"`, `revealed: true`, `secret_name` as the predicate says; fail closed with
503), then the same live-or-snapshot choice. Live: a `read` request with `mask: false`. Snapshot: the Phase 1
service with a `reveal` option that skips the masking. The response is a content response with
`masked: false, revealed: true`. The audit record is finalized `ok` by the Front Door for the snapshot source and by the
result route for the live source. A reveal of a path that does not look secret is still a read and still audited.

**Watch** (`POST /watch`): principal, watch counter. `open: true`: if there is a live owner able to serve files
(`liveFileSourceOf` is `live`), conditionally update the record (`owner_id`, generation, not stop-approved)
`SET interactive_until_at = now + 45 s` and answer `state: "live"` with `poll_interval_ms` = the pace the owner was last
given (`ownerFilePanelPace`). `state: "starting"` when an owner exists in `booting` or `hydrating` or the
computer has an unexpired start lease; `state: "off"` otherwise. `open: false`: if live,
`SET interactive_until_at = now`; answer as above. The ping does not queue a request, does not touch the idle state and
is not audited (so a forgotten panel does not keep the computer awake, L12; open question Q2).

### 7.6 Retention and cleanup

| Item | Deleted by | Backstop |
| --- | --- | --- |
| Request item, status `done` | the waiting Front Door handler after it reads the outcome | `expires_at` + 120 s |
| Request item, `delivered` whose waiter gave up (`waiter_gone`) | the result route when the late result arrives (it deletes after finalizing the audit record) | `expires_at` |
| Request item, `abandoned` | payload removed at once; the empty item expires | `expires_at` |
| Audit record | never by code | `expires_at` = 90 days |
| Rate counter | never | `expires_at` = window + 1 hour |

Readers ignore any item past `expires_at`. Part A1's contract test inserts an expired item and
proves the poll, the result route and the count do not see it.

## 8. The file helper

`conversation/src/pi/owner-file-helper.ts` gains operations and fields. Only Node built-ins and
`@chatticus/host-protocol/live-file-rules` are imported (the rules module imports nothing).

```ts
export type OwnerFileOperation = "read" | "write" | "stat" | "realpath" | "list";

export type OwnerFileRequest = {
	readonly operation: OwnerFileOperation;
	readonly path: string;
	readonly allowedRoots: readonly string[];
	readonly contentBase64?: string;               // write (Pi tools)
	readonly content?: string;                     // write (live): UTF-8 text
	readonly precondition?: { type: "if_match"; sha256: string } | { type: "if_none_match" };  // write
	readonly createParents?: boolean;              // write: mkdir -p, the Pi tools only
	readonly refuseGitSegments?: boolean;          // every live request
	readonly range?: { offset: number; length: number; maxFileBytes: number; mask: boolean };   // read: absent means the whole file, as today
	readonly maxEntries?: number;                  // list
	readonly maxScan?: number;                     // list
};
```

The response keeps the shape of today's (`ok` with fields, or `ok: false, code, message`) and
gains `entries`, `resolvedPath` (logical, `/workspace/...`), `sha256`, `sha256Before`, `modifiedMs`, `mode`,
`created`, `keptAs`, `currentSha256`, `truncated`, `masked`, `binary`, `encoding`, `size`,
`offset`, `length`, `content`. Error codes are `LIVE_FILE_OWNER_ERROR_CODES`; the existing
`CHATTICUS_OUTSIDE_WORKSPACE` is mapped to `outside_workspace`, `ENOENT` to `not_found`, `EACCES`
and `EPERM` to `permission_denied`, anything else to `io_error`. `UnprivilegedExecutionEnv`'s `CODES` map
(`pi/unprivileged-execution-env.ts`) keeps working through the same table.

Every operation first resolves the final location (`finalLocationOf`, as today), asserts it
inside `allowedRoots`, and if `refuseGitSegments` asserts the resolved path has no `.git`
segment (`path_refused`). Every operation maps the real path back to `/workspace/...` for
`resolvedPath`.

**`list`.** The resolved path must be a directory (`not_a_directory`). `opendir`, read at most `maxScan`
names (20,000), `lstat` each, sort directories first then by name (the Phase 1 order), keep
`maxEntries`. A symlink entry carries `link_target` from `readlink` (4096 characters at most). A FIFO,
socket or device is left out. `truncated` is true if names beyond the cap exist. Entries carry `modified_at`,
`mode`, `size` (files), no hash.

**`stat`.** `lstat` of the final component without following it, after the containment check of its
parent (today's behavior), returned as an entry.

**`read`.** Resolve, containment. Open the resolved path with `O_RDONLY | O_NONBLOCK`; `fstat` must say regular
file (`not_a_file`) of at most `maxFileBytes` (`file_too_large`). Read it whole, hash it (SHA-256, hex), take
the range, sniff binary with `looksBinary`, trim a text range to a character boundary. If `mask` is true and the
**resolved** path or the requested path looks secret, return `masked: true` with `size` and `sha256` and no content (the
same as the snapshot's masked answer). With no `range` the whole file is returned as base64 and no cap applies: that is the
Pi `read_workspace` path, unchanged.

**`write`.** In this order:

1. Resolve and contain. `if_none_match`: `lstat` the final location must be `ENOENT` else `already_exists`. Creating needs the
   parent directory (`parent_missing`) unless `createParents`.
2. `if_match`: open the final location `O_RDONLY | O_NONBLOCK`, `fstat` regular (`not_a_file`) and at most 256 KiB
   (`file_too_large`), hash. Different: `precondition_failed` with `currentSha256`. Keep this descriptor open.
3. Create `.<name>.chatticus-<32 random hex>.tmp` in the resolved directory with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`,
   write the bytes, `fsync`, `fchmod` to the old file's permission bits (`0664` for a new file).
4. Compare again immediately before publishing: `if_match`: hash the file at the final location again;
   `if_none_match`: `lstat` again. A difference unlinks the temporary file and answers `precondition_failed`
   or `already_exists`.
5. Publish: `rename(temp, final)` for a replace; `link(temp, final)` then `unlink(temp)` for a create (`EEXIST` is
   `already_exists`).
6. Post-check (replace only): re-hash through the descriptor of step 2, which still reads the replaced inode. If it
   differs from the expected hash, someone wrote that inode in place between steps 4 and 5. Write its bytes to
   `<final>.chatticus-replaced-<8 hex>` (the shell user's own file, in the same directory) and answer ok with `keptAs`.
7. Answer `created`, `size`, `sha256Before`, `sha256` (of the new bytes), `modifiedMs`.

On every failure after step 3 the temporary file is unlinked. A helper killed by its timeout can leave
`.chatticus-*.tmp` behind; it is visible in a listing and harmless (YAGNI: no sweeper). The window that remains is the time
between step 6's read and the end of the helper (a write into the replaced inode after the post-check): microseconds, and
the result is the same as a shell redirect landing a moment after a save.

The Pi tools' `write` (`UnprivilegedExecutionEnv.writeFile`) calls this operation with `contentBase64`, `createParents: true`,
no precondition and no `refuseGitSegments`: it now writes atomically (a reader never sees half a file). The existing
scenarios of `computer_owner_file_isolation.feature` stay green and are the proof that the link rules did not move.

## 9. The supervisor (container)

All in `computer/host/src/`. The bundle must not import Pi, `UnprivilegedExecutionEnv`, the starter
or the owner stores (`computer-image-structure.test.ts`). `scrubbedShellEnvironment`
(`conversation/src/pi/local-computer-tools.ts`) is moved, unchanged, to
`conversation/src/pi/shell-environment.ts` (no imports beyond Node) and imported by both.

### 9.1 The file runner

New `live-file-operations.ts`, class `LiveFileOperations`, with ports so a scenario supplies fakes:

```ts
export interface FileHelperLauncher {
	/** Run the helper once with this request on standard input; kill it at the timeout; resolve with its parsed answer or a helper error. Never rejects. */
	run(request: OwnerFileRequestToHelper, timeoutMilliseconds: number): Promise<OwnerFileResponse>;
}

export type LiveFileOperationsOptions = {
	readonly launcher: FileHelperLauncher;
	readonly postResult: (operationId: string, outcome: LiveFileOutcome) => Promise<"recorded" | "closed">;
	readonly clock: SupervisorClock;
	readonly log: LogEmitter;
	readonly workspaceRoot: string;
	readonly memoryUsedPercent: () => number | undefined;
	readonly onFinished: (kind: OwnerFileRequest["kind"], outcome: LiveFileOutcome) => void;
};
```

`ProcessFileHelperLauncher` (`live-file-helper-launcher.ts`) starts
`<launcher> -c 'exec "$@"' chatticus-file-helper <node> file-helper.mjs` with `cwd = workspaceRoot` and the
scrubbed environment, writes the JSON request to standard input, reads at most 1 MiB of standard output, and at the timeout sends
SIGKILL to the process group. It does exactly what `UnprivilegedExecutionEnv.ask` does and nothing else; it never opens a
path itself.

`LiveFileOperations.accept(requests)`, called by the supervisor for each poll answer:

* A request id already known (running, queued, or finished within the last 60 seconds) is ignored; a finished one whose
  post failed is posted again.
* Stopping: the answer is `error owner_stopping`. Memory at or above 90 percent, or more than 8 queued: `owner_busy`.
* Otherwise queue; at most 2 helpers run. A queued request whose `expires_in_ms` (measured from receipt on the monotonic
  clock) lapses before it starts is answered `expired` without touching the disk.
* The request is turned into a helper request: `refuseGitSegments: true`; `read` gets
  `range: { offset, length, maxFileBytes: 8388608, mask }`; `list` gets `maxEntries` and `maxScan: 20000`; `write` gets
  `content`, `precondition`.
* The helper's answer is validated against `liveFileOutcomeSchema`; one that does not parse is `helper_failed`. A
  timeout is `helper_timeout`.
* The result is posted with up to 3 attempts, 1 second apart, on a network error or a 5xx. `closed` (409 `operation_closed`)
  drops it. A 401 or a superseding 403 ends the supervisor as superseded, as for a poll.
* `onFinished` lets the supervisor restart its idle clock (L12) and, for an `ok` write, schedule the quiet publish (L13).

`pause()` and `resume()` and `stopAccepting()` are L17. A paused runner queues; it does not answer. `stopAccepting()` is
called first thing in `performStop` and in the SIGTERM path.

### 9.2 Supervisor changes

* `OWNER_PROTOCOL_VERSION` becomes 2.
* `onPollAnswered` hands `response.file_requests` to `accept`. File requests are accepted in every state except `booting`
  and `hydrating`: the supervisor answers those `owner_busy` (the server does not deliver in those states; this is the belt).
* `onChildExit`: `await files.pause(); try { await sweep } finally { files.resume() }`.
* `performStop`: `await files.stopAccepting()` before `terminateChild`.
* On `onFinished`: if the state is `idle`, `startIdleClock()` (an `owner_idle` line restarts the count); for a write,
  `nextPublishCheckAtMilliseconds = min(existing, now + OWNER_QUIET_PUBLISH_SECONDS * 1000)`. While a child runs the publish
  stays deferred (C14).
* `protocol-client.ts`: `OwnerSupervisorClient.postFileResult(request)` with `ownerFileResultRequestSchema` and
  `ownerFileResultResponseSchema`, the same headers and error handling as `poll`.
* `supervisor-main.ts` wires `ProcessFileHelperLauncher`, `fileHelperCommand`
  (`[process.execPath, join(dirname(import.meta.url), "file-helper.mjs")]`, as `owner-main.ts:23` does) and `containerMemoryUsedPercent`.

### 9.3 Logs

One line per operation, from the supervisor, never a path, a name or a byte of content:
`file_operation`: `kind`, `bytes`, `path_hash` (first 12 hex of SHA-256 of the path), `source` (`live`), `outcome`
(`ok` or the error code), `duration_ms`, `queue_ms`. Other lines: `file_operation_refused`
(`reason`: `owner_stopping`, `owner_busy`, `expired`), `file_operation_post_failed` (`status` or `error_name`,
`attempt`). Front Door lines (no content, no path): `file_op_queued`, `file_op_abandoned`, `file_op_delivered`,
`file_result_recorded`, `file_result_refused code=<code>`, `file_audit_failed`, `file_rate_limited class=<class>`.

## 10. The web app

Files: `web/lib/computer-files.ts`, `web/lib/computer-files-api.ts`, `web/lib/touched-files.ts`,
`web/components/workspace/ComputerFilesPanel.tsx`, `web/components/workspace/ComputerFilesView.tsx`, the fixtures and tests
beside them. Read `docs/BRAND_GUIDELINES.md` before touching a background, region or border: the new banners are flat
surfaces like the existing notices, with no new border. The web app does not import `host-protocol` (it is not a dependency of
`web/`); it mirrors the JSON of section 5.2 in its own types, and the `@web` scenarios are what keeps the two honest.

### 10.1 What the panel shows

| Situation | The response says | The panel shows |
| --- | --- | --- |
| Live | `source: "live"`, `stale: false` | A source line `Live from the computer` with a status dot and `aria-live="polite"`; the listing and file may be edited |
| Computer off | `source: "snapshot"`, `stale: false` | `Computer is off. Showing the copy saved <relative time>` (today's `SavedCopyNote` wording with the time); no editor |
| Fallback | `source: "snapshot"`, `stale: true` | `Could not reach the running computer. Showing the saved copy from <time>` with a Retry button; the panel asks again after `retry_after_ms` (default 2 seconds), three times, then waits for a click; no editor |
| Starting | watch `state: "starting"` | `The computer is starting. Showing the saved copy` |
| Warming | `fallback_reason: "owner_warming"` | `Connecting to the running computer` (not an error), asks again at `retry_after_ms` |

`FileListing.source` and `FileContentRange.source` widen to `"snapshot" | "live"`; both gain `stale`, `fallback_reason`,
`retry_after_ms?`; content gains `revealed`, `editable`, `modified_at`; an entry gains `modified_at`.

### 10.2 The watch ping

While the Files tab is the visible inspector tab and `document.visibilityState === "visible"`, the panel posts
`/computer/files/watch` `{ open: true }` on mount and then every 15 seconds. When the tab is hidden, switched away from or
unmounted it posts `{ open: false }` once (best effort, `fetch` with `keepalive`; the 45 second window is the guarantee). The
answer drives the source line before any file is read. A 429 stops the ping for a minute. The ping carries no content and no path.

### 10.3 Reading while live

No timer re-reads a listing or a file (design non-requirement 6). The panel re-reads in these cases only: the member
navigates, opens or refreshes; a tool call of the running turn names the open directory or file (`touched-files` already
collects `write_workspace`, `edit_workspace` and `read_workspace` paths from the tool cards; the panel re-reads an open, unedited
file or listing when its entry changes); and the editor probe below.

### 10.4 Edit mode

Offered when the content response has `editable: true`, as a button `Edit` beside Copy. The text area is plain monospace text,
the whole file (a file over 256 KiB or truncated shows `This file is too large to edit here` and no button). State, a pure
function in `web/lib/computer-files-edit.ts` (`vitest`):

```
viewing -> editing(loadedSha256, loadedText, draft) -> saving -> saved -> viewing(new sha256)
                                    |                      |
                                    |                      +--409 precondition_failed--> conflict(currentSha256, theirText, draft)
                                    +--changed on the computer--> editing + warning(piChanged)
```

* **Save** sends `PUT` with `If-Match: "<loadedSha256>"` and `{ content: draft }`. While saving, the button is disabled and the
  status reads `Saving`. 200: `Saved on the computer`, the new `sha256` becomes `loadedSha256`, the file leaves edit mode. A
  line under it reads `The saved copy catches up in about a minute` when `backed_up` is false (it always is at response time).
  `kept_as` present: a notice `A change made at the same moment was kept as <name>`.
* **New file**: in a live listing a `New file` button asks for a name (must not contain `/`), creates it with
  `If-None-Match: *` and an empty draft, and opens the editor. 409 `already_exists`: `A file with that name exists`.
* **Leaving** (Back to folder, opening another file, navigating, the tab switching away) with a changed draft asks `Discard your
  changes?` with `Keep editing` and `Discard`. Reload with unsaved changes asks the browser's own prompt.
* **Errors** keep the draft: `owner_warming` and `owner_timeout` (`Could not reach the computer; your text is kept`, Retry),
  `outcome_unknown` (`Not sure the save happened. Reload the file to check`, with a Reload button that reads the file and shows
  the conflict banner if it differs from the draft), `rate_limited`, `computer_not_live` (`The computer is off. Your text is kept;
  ask a bot to do something to wake it`; open question Q1), `content_too_large`, `file_too_large`, `path_refused`, `precondition_required`
  (a bug, shown as a generic error).

### 10.5 The conflict banner

On 409 `precondition_failed` the panel reads the current file (`GET /content`, live) and shows a banner above the editor:
`This file changed on the computer while you were editing.` with the other version beside the member's draft (two read-only
panes on a wide viewport, stacked on a phone), `current_sha256` as the new base, and three buttons: `Overwrite with mine`
(`PUT` with `If-Match` of `current_sha256`, an ordinary audited write), `Use theirs` (drops the draft after the discard
prompt), `Copy mine`. The draft is never lost without a click. There is no merge.

### 10.6 `Pi changed this a moment ago`

A non-blocking notice above the editor, with a `Show their version` button that opens the same comparison as the banner. It
appears when either:

1. a tool card for `write_workspace` or `edit_workspace` whose normalised path equals the open file appears or changes
   status, in the live turn or the last committed message, within the last 60 seconds of the browser's clock (`ToolCardModel`
   has no timestamp; the panel stamps the time it first sees a card, and `collectTouchedFiles` returns a `lastCallId` per path so
   a second write to the same path is a change); or
2. the editor probe finds a change. While a file is in edit mode the panel calls `GET /stat?path=` every 5 seconds
   (`LIVE_FILE_EDIT_PROBE_SECONDS`; paused while the tab is hidden) and compares `size` and `modified_at` with the values at load.
   The probe catches a shell command (`git checkout`, `sed -i`) that no tool card names. Each probe is a file request through the poll
   channel: about 12 a minute against a limit of 240.

Tool events carry the model's path as typed, up to 500 characters (`conversation/src/turn/tool-event-fields.ts:12`) and
`argumentsTruncated` when cut; a truncated or unnormalizable path is not matched (the probe is the safety net).

### 10.7 Masked files

A masked content response shows the existing `This file looks like it holds a secret and is not shown` and a `Reveal` button.
It opens a confirmation: `Showing this file is recorded in the audit log, with your name and the time.` with `Reveal` and
`Cancel`. Confirmed: `POST /reveal`, the text is held in component state only (never in storage, never in the URL), shown with a
`Hide` button, cleared on Hide, navigation, tab switch and unmount. A revealed file may be edited (the same `If-Match` of its
revealed `sha256`); every save is audited like any other.

### 10.8 Accessibility and phone width

Controls keep the 44 pixel minimum used by the existing buttons (`min-h-11`); the source line and the status messages are
`aria-live="polite"`; the conflict banner is `role="alert"`; focus moves to the banner when it appears and back to the Save
button after a choice; every state has text, not only colour. At 375 pixels the two-pane comparison stacks and the editor uses
the full width.

## 11. State machines

### 11.1 A file request item (server)

```
(none) --queue (transaction)--> pending --deliver (poll)--> delivered --result route--> done --Front Door reads--> (deleted)
                                   |                            |                          |
                                   +--abandon (Front Door)--> abandoned          waiter_gone: result route deletes
                                   +--expires_at--> (absent to every reader)
```

Events that do nothing: a result for `abandoned`, `pending` or absent (409 `operation_closed`); a second identical result for `done` (200);
a second different result (409). Only one owner id ever holds a request: the one named on the item at queue time.

### 11.2 One request inside the supervisor

```
received --(known id)--> ignored | re-post stored result
received --(stopping)--> answered owner_stopping
received --(busy / queue full / memory)--> answered owner_busy
received --> queued --(expires_in_ms lapsed)--> answered expired
queued --> running --> answered --> posted --> remembered 60 s
                          `-- helper timeout (6 s) --> answered helper_timeout
```

`pause()` holds `queued` requests back from `running`. `stopAccepting()` answers new ones `owner_stopping` and waits for `running`.

### 11.3 One member request (Front Door)

```
GET:  authenticated -> limited -> source chosen -> [snapshot answer]
                                              `-> queued -> waiting -> done -> answered live
                                                              |-> abandoned -> snapshot answer (stale)
                                                              `-> delivered, no result in 8 s -> snapshot answer (stale), waiter_gone
PUT:  authenticated -> limited -> headers/body/path ok -> live? -> audit pending -> dirty -> queued -> waiting
         -> done: ok -> 200 | conflict -> 409 | other error -> mapped
         -> abandoned -> 504 owner_timeout (audit failed)
         -> delivered + 7 s more -> 504 outcome_unknown (audit stays pending; the result route finishes it)
```

### 11.4 Audit outcome

`pending` -> `ok` | `conflict` | `refused` | `failed`; `pending` read after 120 seconds is `unknown`. A `refused` record is written
directly (`path_refused`) and never passes through `pending`.

### 11.5 Interactive window

`interactiveUntilAt` is set by a watch ping (`+45 s`), by queueing a request (`+45 s`) and cleared by `open: false` (`= now`). The poll
reads it: before it, the owner is told the interactive pace in states that can serve files; after it, the normal tier. It is removed with
the owner fields when the owner ends.

### 11.6 The panel

`connecting` (watch ping sent) -> `live` | `saved-copy` (off) | `starting` | `warming` -> (retry timer) -> `live`; `live` -> `fallback` on a stale answer
-> retry -> `live`. Editing exists only inside `live`; a transition out of `live` while editing keeps the draft and disables Save until `live`.

## 12. Security

### 12.1 What is protected, and from whom

Members of an organization share one workplace; every enabled member may read and write (D8). What must hold:
a non-member reaches nothing; the owner (root, holding the snapshot credentials) never opens a path a person or the
model named; the trail of edits cannot be edited by the owner or by the shell; a request cannot be replayed to another
computer or another owner; and the owner cannot be made to run out of memory or time by a member.

### 12.2 Confused deputy

| Deputy | Confusion tried | What stops it |
| --- | --- | --- |
| The Front Door acting for a member | A member of organization B names organization A in the path | `resolvePrincipal` takes the tenant from the path and checks the membership row of that tenant (`auth/principal.ts` `verifyOrgAccess`); every partition key is built from `principal.tenantId`. Scenario "A member of another organization is refused". |
| The Front Door acting for the owner | An owner token used on the member routes, or a member token on the owner routes | The member routes call `resolveUserPrincipal`, which refuses worker credentials and any token that is not a Cognito user token; the owner routes accept only `computer-owner` audience tokens. Scenario "A supervisor token does not open the member file routes". |
| The supervisor (root) acting on the shell's behalf | A link the shell planted makes root read or write a file the shell could not | The supervisor never opens a path. The helper runs as uid 2000 through `chatticus-shell` with no capabilities (`computer/chatticus-shell`); whatever a link leads to, the operation reaches only what the shell reaches; the helper additionally refuses a final location outside the workspace. The supervisor's code does not call `stat`, `realpath` or `open` on any path in a request: a test greps the new modules for `node:fs` imports. |
| The helper acting on a path | `notes` is a link to `.git/config` or to `.env` | The helper tests the **resolved** path for the `.git` segment (L23) and for the secret names (L18). |
| The result route | An owner posts a result for another computer's request, for a request it was not given, or twice with different content | Tenant partition, owner id, generation, status `delivered` and a compare-and-set (6.1, 7.4). |
| The audit | A member's edit credited to another member | `user_id` from the principal, never the body; the request item carries the same user id and the result route copies it. |

### 12.3 Symlinks and the time-of-check to time-of-use windows

1. **Path check to open** (planted or swapped link). Closed by the privilege boundary, not by the check: the helper is uid 2000, so a
   link swapped between the check and the open leads where the shell could already go (`owner-file-helper.ts` header). The
   containment test and the `.git` and secret tests on the resolved path are a second line and the reason the behavior is testable on
   a machine with no second user.
2. **Special files.** `O_NONBLOCK` and `fstat` regular-file check remove the hang of a FIFO or a device (L15); a file swapped for a FIFO after the
   check is opened with `O_NONBLOCK` and refused after `fstat`.
3. **Precondition to rename.** The helper compares the hash, writes the temporary file, compares again, then renames. A concurrent
   writer that writes the **same inode in place** (the shell `>`, Pi's former in-place `writeFile`) between the second comparison and the rename is
   detected by the post-check through the descriptor held since the first read, and the replaced bytes are kept beside the file (`kept_as`, L16).
   The residue is a concurrent writer that replaces the file **by rename** inside that same few-microsecond window: its file is a complete file and
   ours replaces it, which is what two people saving a moment apart without a lock produce. Node has no atomic exchange-if-unchanged, so this is
   stated, not closed. A change made after the post-check is indistinguishable from a change made a moment after the save.
4. **Delivery to abandonment.** A write the Front Door gave up on must not run later. The request is delivered only by a conditional update
   `pending -> delivered`; the Front Door abandons only by `pending -> abandoned`; exactly one wins. A delivered write the Front Door stopped
   waiting for is reported `outcome_unknown`, never "not done".
5. **Queue to stop.** Closed by the token on the computer record and the transaction (L11); the stop sequence finishes the operation in flight
   (L17), so an accepted edit is in the final publish.
6. **Membership removed.** The 30 second membership cache lets a removed member write for up to 30 seconds. Accepted and stated (L24).
7. **Temporary file names.** Random 128 bit names and `O_EXCL | O_NOFOLLOW`: the shell cannot pre-plant the name.

### 12.4 A compromised owner

An attacker who holds the supervisor token (a stolen token inside its hour, or code running in the container with the token) can:
delay, drop or fail any file request (availability, visible as fallbacks and `owner_timeout`); return invented file content to the member
(display only: text through React, images from a fixed list of types, SVG and HTML as source; `nosniff`); report wrong hashes
(the audit records the Front Door's computed `sha256_after` and flags a mismatch; a wrong `current_sha256` only makes a conflict
confusing); read every request the poll gives it, which includes the **content of a member's edit** and, for a reveal, nothing more than the
owner could already read from the disk. It cannot: read or write the audit family or the request family in the table (the supervisor role has no
DynamoDB access; no owner route returns an audit record; the per-turn role does not list those partitions); obtain a request for another
organization, computer or owner (the poll queries one partition for one owner id and generation); forge a member's identity.
A compromised per-turn child (it holds turn credentials and may write `T#computer#record`, W25) can set `interactive_until_at`
and `file_operation_id` on the record: it can make the owner poll fast (cost) or delay an idle stop; it cannot queue a request, forge a
result or touch the audit. Scenarios "The owner cannot read the audit log" and "The owner cannot read or write the file operation records
directly" evaluate both policy files (`owner-role-policy.json`, `supervisor-role-policy.json`) against the key families with the existing IAM
evaluator (`features-support/iam-policy-evaluator.ts`).

### 12.5 Denial of service through file operations

| Vector | Bound |
| --- | --- |
| A member floods requests | 240 reads, 30 writes, 10 reveals, 12 watch pings per user per minute (429); at most 16 open requests per computer (429 `too_busy`); the counters are in the table, so the limit holds across Front Door instances |
| A request holds a Front Door invocation | at most 8 seconds (15 for a delivered write); the wait loop does a consistent read per 250 ms (about 32 consistent reads per request, about 0.00001 USD) |
| One request is huge | write body 256 KiB (413 before the owner is asked); read range 256 KiB; item size test; a listing at most 2000 entries; a read of a file over 8 MiB refused |
| The poll response grows | at most 4 requests, each at most 256 KiB, so about 1.4 MB base64 worst case in a Lambda response (limit 6 MB) |
| The owner runs out of memory | 2 helpers at a time, 8 queued, `owner_busy` at 90 percent memory, a helper reads at most 8 MiB, the supervisor reads at most 1 MiB of helper output, each helper dies at 6 seconds. ASSUMPTION: a Node helper costs 40 to 60 MiB; the container test must measure two helpers plus a publish at 512 MiB (risk R1) |
| A hostile directory | the scan stops at 20,000 names; special files are skipped; a deep tree costs one call per directory |
| A hanging helper (FIFO, slow disk) | `O_NONBLOCK`, `fstat`, the 6 second kill of the whole process group |
| An unbounded audit table | 30 writes a minute a user; 90 day TTL; records are about 600 bytes |
| Fast polling left on | the window is 45 seconds from the last ping; a forgotten tab pings every 15 seconds, so polling stays at 1 second while the computer lives (at most 50 minutes), about 0.7 cents an hour |
| Many sweeps and operations | the mutex of L17 bounds the wait to one helper timeout |

### 12.6 Secrets and data at rest

File content passes through the table for at most the length of a request and is deleted by the code that reads it (L10); the
audit holds hashes and sizes, never content; the browser holds a revealed secret in memory only. Logs carry a 12 hex digit hash of the
path, never the path or the content (the redaction rule of `owner-main.ts:39-41` extended). Masked answers still carry the whole-file
`sha256` (as Phase 1's do): a member can reveal anyway, so the hash gives no member a capability, but an offline guess of a weak
secret from its hash is possible; accepted (Q5). Tokens never appear in file routes: the member's bearer is verified and dropped.

### 12.7 Findings, status

| Finding | Status |
| --- | --- |
| 1. Symlink escape in file tools | Holds. The new operations run in the same helper through the same launcher; the supervisor opens no path; a planted link scenario covers every new operation (`@supervisor` links, FIFO, `.git`). |
| 2. Invoke key reaches every owner | Holds. The new owner route takes only the supervisor token. |
| 4. Tenant-wide table reach | Holds. No role gains a statement; the two new key families are outside both. |
| Audit tampering (design 14) | Closed by the key families and the Front Door being the only writer. |

## 13. Traceability

Scenario names are those of `features/computer_file_live.feature`. Tags: `@server` (A1, A2), `@supervisor` (C), `@web` (W),
`@end-to-end` (E). `vitest` is the unit-test exception of `AGENTS.md`: pure helpers only.

| # | Requirement | Section | Scenarios | Tag |
| --- | --- | --- | --- | --- |
| LF-1 | A read of a running computer reflects what is on its disk now, not the last publish | 7.2 | A live read reflects a change that was never published; A live listing shows a file the saved copy does not have | server |
| LF-2 | A computer that is off is answered from the snapshot and is not stale | 7.2, L4 | A computer that is off is answered from the saved copy and is not stale | server |
| LF-3 | An owner that is hydrating, too old, or stopping is answered from the snapshot with the reason, stale | L2, L3 | An owner that is still hydrating is answered from the saved copy and marked stale; An owner that predates file operations is answered from the saved copy | server |
| LF-4 | A live request that times out falls back to the snapshot with `stale` | 7.2 step 4.6 | A live request that times out falls back to the saved copy and says stale | server |
| LF-5 | A slow owner is not waited for; the panel is told when to ask again | L27 | An owner that is slow to poll is not waited for | server |
| LF-6 | A live not-found is an answer, never replaced by the snapshot | L28 | A file deleted on the computer is not found even though the saved copy has it | server |
| LF-7 | Reads are ranged, hashed as a whole, capped | L15 | A binary file is returned in pieces and every piece names the hash of the whole file; A file over the read limit is refused with its size; A listing is cut at 2000 entries | server |
| LF-8 | A member's edit reaches the disk and marks it dirty | 7.3, L14 | A member edits a file and the owner has it | server |
| LF-9 | A write with a stale hash is refused 409 and nothing changes | 7.3 | A write with a stale hash is refused and nothing changes; A concurrent edit by the bot is reported as a conflict with the bot's version | server |
| LF-10 | A write needs a precondition; a create only if absent | 6.2 | A write without a precondition is refused before it reaches the owner; A new file is created only if it does not exist | server |
| LF-11 | The size limits hold before the owner is asked and in the helper | L15, L20 | A write larger than 256 KiB is refused before it reaches the owner; A file larger than the edit limit cannot be replaced | server |
| LF-12 | A write into `.git` is refused, lexically and after links | L23 | A write into a .git directory is refused; A link inside the workspace to a .git file is refused by the helper as well | server, supervisor |
| LF-13 | A write needs a live owner able to serve it | L2, L5 | A write is refused when the computer is off; A write to an owner that will not poll soon is refused with a retry time; A write is refused while the owner is stopping | server |
| LF-14 | A write the Front Door gave up on never runs later; a delivered one is reported unknown and audited when it lands | L9 | A write the owner never took does not happen later; A write the owner took but did not answer is reported as unknown and audited when the answer comes | server |
| LF-15 | An idle stop is vetoed by a pending request, and a stop and a request cannot both win | L11 | An idle stop is vetoed while a file operation is pending; A stop and a file operation cannot both win; A request is not handed to an owner that is stopping | server |
| LF-16 | A stopping supervisor finishes the operation in flight and refuses the rest, so an edit is in the final publish | L17 | A stopping supervisor finishes the operation in flight and refuses the rest | supervisor |
| LF-17 | An edit lands in the audit log; refused edits too; no content | L21, L29 | An edit lands in the audit log; A refused write is audited as refused | server |
| LF-18 | The audit record exists before the owner is asked (fail closed) | L21 | The audit record is written before the owner is asked | server |
| LF-19 | Hashes the owner reports are checked against what the Front Door sent | L21 | An owner whose hashes disagree with what was sent is flagged in the audit record | server |
| LF-20 | Reading is not audited | L29 | Reading a file is not audited | server |
| LF-21 | The owner cannot read the audit family or the request family | 12.4 | The owner cannot read the audit log; The owner cannot read or write the file operation records directly | server |
| LF-22 | Secret-looking files are masked, also through a link and also if the owner forgot | L18, L25 | A masked secret file is listed but its content is not returned; A link with an ordinary name to a secret file is masked too; A secret the owner did not mask is masked by the Front Door | server |
| LF-23 | A reveal returns the content and is audited, from both sources, and fails closed | 7.5 | Revealing a masked file returns its content and is audited; A reveal is refused when the audit record cannot be written; A secret is revealed from the saved copy and audited as well | server |
| LF-24 | A revealed secret does not stay in the table | L10 | A revealed secret does not stay in the file operation record | server |
| LF-25 | Only an enabled member of the organization, with a user principal, may use the routes | L24 | A member of another organization is refused; A caller with no member token is refused; A supervisor token does not open the member file routes; A member of a suspended organization cannot edit | server |
| LF-26 | Paths outside the workspace are refused before the owner is asked | 5.1 | A path that is not under /workspace is refused before anything is asked of the owner | server |
| LF-27 | Per-user and per-computer limits | L22 | A member who asks too often is told to wait; Too many pending file operations are refused at once | server |
| LF-28 | The poll delivers a request once, and again only for a repeated poll | 7.4 | The poll delivers a file request once and again only when the poll is repeated | server |
| LF-29 | The result route accepts a result only from the owner that was given the request, once | 7.4 | A result from an owner that was not given the operation is refused; A result for an abandoned operation is refused; A result is recorded once; A result that does not parse is refused | server |
| LF-30 | An open panel makes the owner poll every second, and the pace returns after it closes | L6, L7 | An open panel makes the owner poll every second; The owner returns to its normal pace after the panel closes; A panel that says it is closed ends the fast pace at once; A busy owner polls every second while a panel is open | server |
| LF-31 | An open panel does not keep the computer awake; a panel of a computer that is off learns it | L12 | A panel that is open does not keep the computer awake; A panel that is open when the computer is off learns it | server |
| LF-32 | The helper lists, with kinds, sizes and link targets | 8 | The helper lists a directory with kinds, sizes and link targets | supervisor |
| LF-33 | A planted link cannot make the owner read or overwrite what the shell cannot reach; a link inside the workspace is written through | L16 | A planted link to a file outside the workspace is not read; A planted link to a file outside the workspace is not overwritten; A link inside the workspace is written through and stays a link | supervisor |
| LF-34 | A special file or a hanging helper cannot wedge the supervisor | L15 | A pipe in the workspace does not hang a read; A helper that hangs is killed at its timeout | supervisor |
| LF-35 | A request that cannot start in time is answered expired without touching the disk | 9.1 | A request that waited too long in the supervisor is answered expired without touching the disk | supervisor |
| LF-36 | A file operation is not killed by the sweep | L17 | A file operation in flight is not killed by the sweep after a turn | supervisor |
| LF-37 | An edit counts as activity and schedules the quiet publish | L12, L13 | An edit schedules a quiet publish and counts as activity | supervisor |
| LF-38 | The supervisor logs no path and no content | 9.3 | The file operation line carries no path and no content | supervisor |
| LF-39 | A superseded owner stops when it posts a result | 9.1 | An owner that is told it is no longer the owner stops when it posts a result | supervisor |
| LF-40 | The panel says whether it is live, the saved copy, or a fallback, and retries | 10.1 | The panel says whether it shows the live computer or a saved copy; A fallback to the saved copy says so and tries again | web |
| LF-41 | A member edits, saves, and is asked before discarding | 10.4 | A member edits and saves a file; Leaving an edited file asks first; A file that is too large to edit offers no editor | web |
| LF-42 | A conflict shows the other version and never loses the draft | 10.5 | A conflict shows a banner with the other version | web |
| LF-43 | The panel warns when Pi changed the open file | 10.6 | The panel warns when Pi changed the open file a moment ago; The panel warns when the open file changed on the computer without a tool call | web |
| LF-44 | A reveal is confirmed first and the secret does not linger | 10.7 | A masked file asks before it is revealed | web |
| LF-45 | The panel signals it is open and stops when hidden | 10.2 | The panel tells the computer it is open and stops when it is hidden | web |
| LF-46 | The whole path works with a real supervisor, helper and a bot turn | 1 | A member edits a file while no turn runs and the bot reads it back; Both sides edit the same file at once and exactly one edit stands; An edit is in the saved copy after the quiet publish | end-to-end |

**Unit tests (vitest), the exception of `AGENTS.md`:** `live-file-rules` (`livePathProblem`, `normalizeLivePath`,
`livePathHasGitSegment`, `looksLikeSecretFile`, `looksBinary`, `trimToCharacterBoundary`); the schemas of section 5.2 (including the item
size test of L20 and the unknown-field rules); `ownerFilePanelPace`; the expected-pickup arithmetic of L27; the helper's atomic write with an injected hook between the second
comparison and the rename (the post-check keeps the replaced bytes; the temporary file is removed on every failure; the create is exclusive); the runner's queue
and mutex with a fake launcher and clock; the audit and request codecs; the store contract test (conditional updates, transaction, expired items
ignored, `waiter_gone`); `web/lib/computer-files-edit.ts` and `touched-files.ts`. None of these duplicates a Gherkin scenario: each is a pure
function or a codec.

## 14. Open questions for the owner

These are product questions. The contract is written for the recommendation; none is decided for you.

- **Q1. Writing while the computer is off.** Recommendation: refuse (409 `computer_not_live`), keep the person's text in the panel, and say
  to ask a bot to do something to wake it. The alternatives are a `Wake` button (needs a start path that does not need a parked turn:
  `ComputerStartJob` carries a turn id and the starter fails a turn on refusal, `domain/computer-start.ts`; a half-day change plus a scenario
  and a spend-ceiling decision), or queueing the edit for the next boot (rejected: a hidden second source of truth). Which is wanted for Phase 3?
- **Q2. Does an open Files panel keep the computer awake?** Recommendation: no. Only file operations count as activity, so a forgotten tab
  costs at most 15 minutes of idle time and fast polling for that long. D6 decided "yes" for an open preview tab; this is the file panel's answer.
- **Q3. The panel pace.** Recommendation: 1 second (L7), about 0.7 cents an hour while a panel is open. The design's 0.5 second costs about 1.4 cents
  an hour, the same as the computer. Is the faster pickup (average 0.25 s instead of 0.5 s) worth doubling that?
- **Q4. Who may read the audit log, and where?** Recommendation: operators only in Phase 3 (the table); a member-facing `History` for the organization
  owner role comes with delete and move. Say if an owner needs to see edits sooner.
- **Q5. Secrets.** Recommendation as D8: every enabled member may reveal, and every reveal is audited. Confirm that members, not only owners, may reveal, and
  that a member may edit a secret-named file after revealing it. Also: the masked answer carries the file's hash (Phase 1 does).
- **Q6. The read limit.** Recommendation: 8 MiB live (the snapshot allows 50 MiB), because every page of a ranged read hashes the whole file. A file between
  8 and 50 MiB is readable from the snapshot and not live. Raise it later with a cached hash if a person asks.
- **Q7. Audit content.** Recommendation: hashes, sizes and paths, never the text of an edit (privacy, cost, secrets in edits). If a "who changed what" history is
  wanted, that is a separate decision with its own retention.
- **Q8. Customer-account computers.** They have a host worker and no owner, so they always read from the snapshot. Confirm that is acceptable for Phase 3.
- **Q9. Telling the bot.** Recommendation (YAGNI list of the design): no channel notice when a person edits a file; the bot finds out by reading. The cost
  is that the bot's context can be stale until it reads. The separate `Ask Pi to change this` button stays.
- **Q10. What the audit records about the caller.** Recommendation: user id and time only. Adding the client IP or user agent is a privacy decision.
- **Q11. Unpublished edits during a long turn.** The supervisor never publishes while a child runs (OWNER_SUPERVISOR_PROTOCOL C14), so an edit made during a
  turn is not in the saved copy until the turn ends, and a crash loses it. Recommendation: accept, show `not yet in the saved copy` until a publish, and let the
  measured memory (risk R1) decide whether C14 can be relaxed for edits later.

## 15. Work assignment

Everything is a pull request into `develop` with the Gherkin first (`AGENTS.md`). Steps for a draft scenario are written by whoever
owns its tag; a scenario enters `features/cucumber-features.txt` together with its steps. This contract, the draft feature and the design
document edits merge first. Do not read or write `project/`. No part touches `infra/`: both owner roles, the
table and the distribution are unchanged (A2 only verifies on development that CloudFront forwards `If-Match` and `ETag`).

### F0. Foundation (first, small; merged before A1, A2, C or W start integrating)

Files: `host-protocol/src/live-file-rules.ts` and `host-protocol/src/live-files.ts` (new, section 5); the three exports and the constants of
section 5.3 in `host-protocol/src/supervisor.ts` and `host-protocol/package.json`; `conversation/src/snapshot/files.ts` (import the shared rules, delete the copies;
`.git-credentials` joins the list); tests `conversation/test/live-file-rules.test.ts`, `conversation/test/live-files-protocol-schema.test.ts`, and the
changes to `conversation/test/owner-supervisor-protocol-schema.test.ts` (poll response with and without `file_requests`, the new veto and error code).
Acceptance: `npm run typecheck`, `npm test`, `npm run test:features` green with no behavior change except the one added secret name. Does **not** change
`OWNER_PROTOCOL_VERSION`.

### A1. Server: store, domain, owner routes (needs F0)

Files: `conversation/src/store/codecs/computer.ts`, `store/codecs/live-file-operation.ts` (new), `store/codecs/file-audit.ts` (new), `store/messaging-store.ts`,
`store/dynamo-messaging-store.ts` (queue transaction, deliver, abandon, complete, count, delete, audit put and finalize, `incrementRateCounter`, `approveOwnerStop`
with the second guard, `touchInteractiveWindow`), `features-support/in-memory-messaging-store.ts` (the same), `domain/computers.ts` (`recordHostSnapshotPublished` and
`recordHostHydrated` as targeted updates, L19, **first commit of the part**), `domain/live-files.ts` (new: `liveFileSourceOf`, expected pickup, `ownerFilePanelPace`,
deliver, record result, finalize audit), `domain/owner-supervisor.ts` (poll delivery, cadence, `stopVeto`, approval token), `http/owner-host-auth.ts`
(`OWNER_COMPUTER_ROUTES`), `http/owner-supervisor.ts` (`ownerFileResultHandler`), `http/app.ts` (declare the route).
Tests: `test/dynamo-messaging-store.contract.test.ts`, `test/owner-supervisor-domain.test.ts`, `test/route-audience.test.ts`, `test/owner-supervisor-client.test.ts` if it lists routes.
Scenarios it makes pass (steps in `features-support/steps/live-files-owner.steps.ts`, a `FakeLiveOwner` in `features-support/fakes/`): the "poll", "result", "fast poll", "idle stop"
and "owner cannot read" scenarios (LF-15 server part, LF-21, LF-28 to LF-31). Acceptance: those scenarios and every existing owner scenario green.

### A2. Server: member routes (needs A1)

Files: `conversation/src/http/routes/computer-files.ts` (live or snapshot, `PUT`, reveal, watch), `http/app.ts` (declare), `snapshot/files.ts` (reveal option, provenance
fields, `modified_at`), `domain/file-audit.ts` (new), `lambdas/front-door-composition.ts` (wire the store methods and the clock/sleep), `http/errors` or the route file for the codes of 6.3.
Steps: `features-support/steps/computer-file-live.steps.ts`. Scenarios: LF-1 to LF-14, LF-17 to LF-20, LF-22 to LF-27. Existing scenarios that change: `computer_snapshot_index.feature`
(responses gain `stale`, `fallback_reason`, `modified_at`, `source` stays `snapshot`). Acceptance: those scenarios green; on development, `curl` shows `If-Match` reaches the handler and `ETag` returns.

### C. Container: helper and supervisor (needs F0; independent of A)

Files: `conversation/src/pi/owner-file-helper.ts` (section 8), `conversation/src/pi/unprivileged-execution-env.ts` (Pi `write` through the same operation),
`conversation/src/pi/shell-environment.ts` (new, extracted), `computer/host/src/live-file-operations.ts` (new), `computer/host/src/live-file-helper-launcher.ts` (new),
`computer/host/src/supervisor.ts`, `supervisor-ports.ts`, `supervisor-main.ts`, `protocol-client.ts`, `unprivileged-process-sweeper.ts` only if the mutex needs a hook, `owner-main.ts` (a
`live-file-probe` subcommand beside `file-probe`), `host-protocol/src/supervisor.ts` (`OWNER_PROTOCOL_VERSION = 2`, one line, **in this part**), `computer/test_owner_container.sh`
(run `live-file-probe` for list, read, write and the `.git` refusal as the shell user), `conversation/test/computer-image-structure.test.ts` (the supervisor bundle does not gain `node:fs`
use on request paths, Pi or the starter).
Tests: `test/owner-file-helper.test.ts` (extend), `test/live-file-operations.test.ts`. Steps: `features-support/steps/live-file-supervisor.steps.ts`, a fake launcher and fake plane in
`features-support/fakes/`. Scenarios: LF-12 (helper), LF-16, LF-32 to LF-39. Acceptance: those green; `computer_owner_file_isolation.feature` and `computer_owner_supervisor.feature` green; the
image builds; `test_owner_container.sh` passes (it needs Docker; an owner of the image runs it, Kanbus `chatticus-6c66c5` tracks the local image build).

### W. Web (needs F0 for the shapes; develops against fixtures; integrates after A2)

Files: section 10. New `web/lib/computer-files-edit.ts`; changes to `computer-files.ts`, `computer-files-api.ts`, `touched-files.ts`, `ComputerFilesPanel.tsx`, `ComputerFilesView.tsx`, the
fixtures; vitest beside each; the `@web` steps in the web harness (`features-support/web-harness-runner.ts`, `steps/web-*.steps.ts`), which has no file-panel steps today and must learn a fake running
computer. Scenarios: LF-40 to LF-45. Acceptance: those green, `npm test` in `web/` green, a manual pass at 375 pixels width, and `docs/BRAND_GUIDELINES.md` followed.

### E. End to end and live proof (needs A2 and C)

Whoever finishes second writes the three `@end-to-end` scenarios (LF-46) in one steps file, runs the live proof (section 17), and the Kanbus and README milestone sub-agent of `AGENTS.md`.

### Order and dependencies

1. This contract (with the feature draft and the design document edits) merges.
2. F0 merges. After it: A1, C and W start in parallel; A2 starts when A1's store interface is merged.
3. C needs only F0 and fakes; A1 needs only F0; W needs only the shapes; A2 needs A1.
4. E needs A2 and C.

### Deploy order (development; no compatibility path)

1. Merge A1 and A2 to `develop`: ThinTurn deploys. Every running owner is protocol 1, so every file request is answered from the snapshot with `owner_too_old`. Nothing breaks; the new
   routes exist; no owner polls `file_requests`.
2. Merge C: CI builds the image. The next owner started is protocol 2 and serves file requests. An owner started before the image is still 1 and still answered from the snapshot until it stops
   (at most 50 minutes).
3. Merge W when A2 is deployed; the panel needs `editable` and `source` from the server (absent `editable` means no editor).
4. Live proof (section 17).

Wait until no owner task is running before step 2 if a clean cut is wanted (`aws ecs list-tasks`); it is not required.

## 16. What changes in existing tests and files

`conversation/test/owner-supervisor-protocol-schema.test.ts` (poll response, veto and error enums, constants), `conversation/test/owner-supervisor-domain.test.ts` (`approveOwnerStop`
signature, poll with file requests), `conversation/test/route-audience.test.ts` (the new routes), `conversation/test/dynamo-messaging-store.contract.test.ts`,
`features/computer_snapshot_index.feature` and `computer-snapshot-files.steps.ts` (new response fields), `features/owner_role_policy.feature` and
`computer_owner_policy_coverage.feature` (the two key families are denied to both roles), `features/computer_owner_file_isolation.feature` (stays green; the Pi `write` is atomic),
`conversation/test/owner-file-helper.test.ts`, `conversation/test/computer-image-structure.test.ts`, `computer/test_owner_container.sh`,
`web/lib/computer-files*.test.ts`, `web/lib/touched-files.test.ts`, `web/lib/computer-files-fixtures.ts`. The list is the author's reading of the code; the implementer finds the rest by running the gates.

## 17. Live proof (development)

1. Send a message that makes a bot create two files. While the turn is done and the computer is idle, open the Files panel: the source line reads `Live from the computer`; the new files are listed and
   openable **before** `snapshot_published` appears in the log. The log shows `file_operation` lines with `path_hash` and no paths.
2. Edit a file in the panel and save: `Saved on the computer`; ask the bot to read it back and it answers with the new text; the owner log shows `file_operation kind=write outcome=ok`, then `snapshot_published` about 30 seconds later.
3. Edit the same file from both sides at once (ask the bot to rewrite it while the panel is in edit mode): one edit stands and the panel shows the conflict banner with the bot's version.
4. In the table, find the audit records of step 2 and 3 (`{tenant}#computer#audit`): user id, path, hashes, outcome, no content. Reveal a `.env` file: a `reveal` record exists.
5. Close the panel and watch the poll pace return from 1 second to the idle tier within a minute (`owner_polling` `interval_ms`). Leave the computer for 15 minutes: `owner_stopping reason=idle`, with the last edit in the snapshot.
6. Reopen the panel with the computer off: `Computer is off. Showing the copy saved ...`, no editor, a write attempt through `curl` is 409 `computer_not_live`.
7. Check on the CloudFront path: `If-Match` arrives, `ETag` returns, the `PUT` body of 256 KiB passes.
8. Measure on a running 512 MiB owner: memory with two helpers reading 8 MiB files during a quiet publish (risk R1).

## 18. Assumptions and risks

**Assumptions** (marked where they appear): CloudFront forwards `If-Match` and returns `ETag` unchanged on `/api*` (6.2); a Node helper costs 40 to 60 MiB (12.5);
SHA-256 of 8 MiB on 0.25 vCPU takes well under a second; the 342 KB worst-case item and result body fit the Lambda and table limits (L20); `fsync` on the task's ephemeral disk is
cheap; the membership cache bound of 30 seconds; DynamoDB `TransactWriteItems` on the computer record and a request item is available with the same client the store already uses
(`dynamo-messaging-store.ts` imports `TransactWriteItemsCommand`).

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Memory at 512 MiB**: supervisor, one Pi turn, two helpers and a publish in one container | concurrency 2, `owner_busy` at 90 percent, 8 MiB cap, helper timeout; measured in the live proof before C14 is touched; the next lever is concurrency 1 |
| R2 | **Poll cost** of the interactive pace with a forgotten tab | 45 second window, no panel keep-alive of the computer, 15 minute idle stop; Q3 |
| R3 | **A lost edit** if the owner dies before the next publish | the dirty flag settles the record; the UI says `not yet in the saved copy`; the quiet publish runs 30 seconds after a write at the next gap; Q11 |
| R4 | **The record race** (L19) was an existing hazard for dispatch fields | fixed first in A1; contract test |
| R5 | **Protocol skew** between a new server and an old owner | the version gate; fallback `owner_too_old`; at most 50 minutes |
| R6 | **Temporary file litter** after a killed helper | recognisable name, listed, harmless; revisit with a sweeper if seen |
| R7 | **Pi `write` changes to atomic** and loses hard links | stated; the isolation scenarios cover links; no hard links are expected in a workspace |
| R8 | **Web harness has no file-panel steps** | W owns extending it; the pure logic stays in vitest so the risk is the harness work, not the logic |
| R9 | **Two sources of truth for masking** (helper and Front Door) | one predicate in `live-file-rules.ts`; the Front Door applies it again (L25) |
