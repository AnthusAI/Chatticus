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
>
> **Revision 2 (owner decisions).** The owner decided that a computer is needed only to *run*
> things, never to view or edit files: a person reads and edits files while the computer is off,
> an open Files panel neither starts nor keeps awake a computer, and the interactive pace is
> 1 second. That replaces the first revision's refusal of a write while the computer is off with an
> **edit overlay** in the snapshot bucket (sections 3 O1 to O4 and L30 to L47, 5.5, 7.7, 9.4, 11.7,
> 12.8, 19). Everything else in this page stands unless a section says otherwise.

## 1. What Phase 3 is

A member of the organization opens the Files panel and sees the files **as they are now**, and can
change a text file. **The computer is needed only to run things, never to view or edit files** (owner
decision O1). Which source answers depends on the computer:

| Computer | Reads | Edits |
| --- | --- | --- |
| Running: an owner of protocol 2 that has finished hydrating and is serving | the owner's disk, through the poll channel | through the owner: an atomic write on the live disk, with a hash check |
| Off, or an owner that is still booting or extracting the snapshot | the saved snapshot with the **edit overlay** merged over it | into the overlay: one small object per edited file in the snapshot bucket, applied by the next owner after it extracts the snapshot and before any turn runs |
| An owner that has sealed the overlay but cannot serve yet (applying) or any more (stopping) | snapshot with the overlay merged, marked stale | refused for a few seconds with a retry time; the person's text is kept |

Viewing and editing never start a computer. An open panel does not keep one awake.

```
Browser (Files panel)
  | GET/PUT/POST /orgs/T/computer/files/...
  v
Front Door Lambda
  | 1. member principal, rate limit, path rules
  | 2. choose the source (7.2): live owner able to serve?  else snapshot + overlay
  | live:    audit first, queue a request in the table (one transaction with the stop guard), wait up to 8 s
  | overlay: audit first, put the blob, compare-and-swap the overlay index in S3 (If-Match)
  v
Messaging table   T#computer#fileops  T#computer#audit              Snapshot bucket  tenants/T/computers/K/
  ^                                                                    snapshot.tar.gz  index/  manifest.json
  | poll response carries file_requests;                               overlay/index.json  overlay/blobs/{sha256}
  | POST /host/owner/file-results carries the answer                      ^           ^
  |                                                                       | reads      | the Front Door alone writes and deletes
Supervisor (root, in the container)  ---- hydrate: extract, seal, apply through the helper, publish, ask to clear
  | spawns, with a timeout and a concurrency of 2
  v
File helper (uid 2000, through chatticus-shell)    list | stat | read(range) | write(atomic, precondition)
  workspace
```

What does **not** change: no socket, no inbound port, no new AWS resource. What does change in
infrastructure (revision 2): the Front Door role gains `PutObject` and `DeleteObject` on the overlay
prefix, and the supervisor role gets an explicit deny of writes to that prefix (section 12.8).

### 1.1 Out of Phase 3 (reserved, nothing implemented)

| Reserved | Phase | Rule until then |
| --- | --- | --- |
| `GET .../files/recent` and watcher-based change events | 5 | The panel reacts to the turn's tool events and to a cheap `stat` probe (section 10). |
| Delete, move, rename, upload, download of large files, creating directories | 5 | The helper has no such operation and the overlay has no tombstones. Creating a file needs an existing parent directory. |
| Writing a binary file or a file over 256 KiB | later | Writes are UTF-8 text up to 256 KiB. |
| Waking a stopped computer from the Files panel | never (owner decision O2) | Viewing and editing never start a computer. |
| Customer-account computers | later (design 10.2) | They have a host worker and no supervisor, so nothing would apply an overlay: reads come from the snapshot only and an edit is refused with 409 `edit_unsupported` (L46). |
| Previews, background processes | 4 | |
| Reading the audit log from the web app | decided (O4) | Operators read the table. |

## 2. What is wrong or underspecified in the design, given the code now live

The design document is from before Phases 1 and 2a. These are the places where it is wrong,
silent or contradicted by `origin/develop`. Each one is settled by a decision in section 3
(L-numbers) unless it says "open".

| # | What the design says or omits | What the code says | Settled by |
| --- | --- | --- | --- |
| W1 | 7.1: "If the computer record says a healthy owner is live, use the owner." | `liveOwnerOf` (`domain/computers.ts:119`) is true for an owner that is booting, hydrating, serving, draining or stopping. A live read of a hydrating disk returns an empty or partial workspace; a write to a stopping owner is lost after the final publish. | L2, L3 |
| W2 | 7.5: "the open file panel keeps it in the 0.5 second mode." No signal path is named. | The poll request is strict and carries nothing about a panel (`ownerPollRequestSchema`); the server learns of a panel only from requests it sees. At the 10 second idle tier, the first request after a quiet time is picked up 0 to 10 seconds later, so about one in five first reads times out against an 8 second wait. | L6, L7 |
| W3 | 9 and 6.1: the 0.5 second mode costs 0.0054 USD/h. | OWNER_SUPERVISOR_PROTOCOL C13 revised the poll cost to one conditional write plus two or three reads: about 0.7 cents an hour at 1 s, so about 1.4 cents an hour at 0.5 s, which is **the cost of the computer itself** (about 1.5 cents an hour with its address). The design's number counted reads only. | L7, O3 |
| W4 | 7.5: items "TTL 120 seconds". | DynamoDB expires items by TTL lazily, typically within 48 hours (the table uses `expires_at`, `infra/lib/thin-turn-stack.ts:50`). A revealed secret, or the content of an edit, would sit in the table long after "expiry". | L10 |
| W5 | 7.5: result route `/host/owner/fileops/{opId}/result`. | `authenticateOwnerHostRequest` matches the owner routes by exact suffix (`OWNER_COMPUTER_ROUTES`, `http/owner-host-auth.ts:27`); a path parameter would not match and would fall through to the invoke key gate. | L8 |
| W6 | 7.5: the Front Door "waits up to 8 seconds" and the response follows. Silent on what a timeout means for a write. | A timeout does not mean the owner did not run the request. A write the owner already took can still land. | L9 |
| W7 | 6.4 and 7.5 list activity that resets the idle clock "a file request". | The stop predicate (`stopVeto`, `domain/owner-supervisor.ts`) knows parked work and live turns only, and the supervisor's idle clock restarts only at a child exit (`startIdleClock` in `onChildExit`, `supervisor.ts`). A file edit would neither veto an idle stop nor postpone it, and a request queued the instant a stop is approved would be lost with its write. | L11, L12 |
| W8 | 6.6: "Quiet publish 30 seconds after the last write ... a file edit landed." | The supervisor schedules a publish check only after hydration, after a child exit and after a publish (`nextPublishCheckAtMilliseconds`); it never publishes while a child runs (OWNER_SUPERVISOR_PROTOCOL C14). An edit alone would wait up to 10 minutes, and an edit during a long turn would wait for the turn. | L13, O4 |
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
| W24 | 7.3 and 7.5: the viewer reads in ranges. | Each ranged read of a live file must hash the whole file (the ETag is the whole-file hash). At 256 KiB a page, a 50 MiB file is 200 pages of 50 MiB hashed each. | L15 (8 MiB cap, accepted: O4) |
| W25 | `owner-role-policy.json` `MessagingWritable` lists `T#computer#record`. | The per-turn child may write the computer record directly. The interactive window and the file-operation token on that record are therefore advisory against a compromised child: it can make the owner poll fast or delay a stop, not forge a request, a result or an audit record, which live in other partitions. | L25 |
| W26 | The design never says how a file is edited while the computer is off (7.5 assumes an owner). | The pack is one `snapshot.tar.gz` at a fixed key rewritten in place and a manifest overwritten after it (`snapshot/s3.ts` `putPack`, `putManifest`). A Lambda cannot and must not rewrite a gzip tar; an edit needs a side store. | L30 |
| W27 | "No infrastructure change." (first revision of this page) | The Front Door role has `s3:GetObject` and `s3:ListBucket` on the snapshot prefix only (`infra/lib/control-plane-stack.ts:414-427`). Writing an overlay needs `PutObject` and `DeleteObject` on its prefix. | L30, 12.8 |
| W28 | The supervisor role "may read" snapshot objects. | Its statement allows `GetObject`, `PutObject` and `AbortMultipartUpload` on the whole computer prefix (`conversation/src/gateway/supervisor-role-policy.json`), which includes any overlay key; and the test IAM evaluator knows only `Allow` (`features-support/iam-policy-evaluator.ts:6`). An explicit deny is needed and the evaluator must learn it. | L37, 12.8 |
| W29 | Hydrate is a single step. | `hydrateOnBoot` returns early with no snapshot (`reason: no_snapshot`) and skips extraction when the local cache checksum matches (`ComputerHostDisk.hydrate`, `cacheMatches`). An overlay applied only after extraction would be skipped on a computer that never published, and on a cache hit. | L42 |
| W30 | Publish makes a new snapshot. | `publishChangedDisk` calls `publishComputerSnapshot` after the upload; a crash between leaves the new pack and the old record. The overlay must be cleared only after a publish **recorded** by the control plane, and a clear can be lost, so applying must be idempotent. | L36 |
| W31 | Snapshot answers are complete. | The pack excludes `node_modules`, `.next`, `dist`, `build`, `target`, `.venv`, `__pycache__`, `.cache` at any depth and files over 50 MiB (`snapshot/exclusions.ts`): an overlay edit under such a directory would be applied and then silently dropped by the next publish. | L40 |
| W32 | The snapshot bucket is just storage. | It is versioned with no expiry of non-current versions (`infra/lib/snapshot-stack.ts:19-29`): an overlay blob deleted after it was applied (possibly a `.env`) stays recoverable as a non-current version. | 12.8, Q-O3 |
| W33 | The file routes serve any computer. | `snapshotFiles` is one `SnapshotFileService` over the Anthus bucket (`lambdas/front-door-composition.ts:216`); customer-account computers use a bucket in the customer's account and a host worker that never applies an overlay. | L46 |
| W34 | A computer with nothing published answers `no_snapshot`. | With an overlay, a computer that has an edit but no snapshot must list `/workspace` as empty plus the edit; `serve()` returns 404 `no_snapshot` first (`http/routes/computer-files.ts`). | 7.7.2 |

## 3. Decisions made in the contract

### 3.0 Decisions of the owner (revision 2)

| # | Decision | Effect on this page |
| --- | --- | --- |
| O1 | The computer is needed only to run things, never to view or edit files. A person reads and edits files while it is off. No refusal with 409. | The edit overlay (L30 to L47, 7.7). The first revision's question 1 is closed; `computer_not_live` is gone. |
| O2 | An open Files panel does not keep the computer awake and does not start it. Only genuine file operations that go through a live owner count as activity. | L12 restated; the watch ping on a computer that is off answers `off` and starts nothing; overlay edits touch no computer record and are not activity. |
| O3 | The interactive pace is 1 second. | L7 confirmed. |
| O4 | Accepted as recommended: audit read by operators only; every enabled member may reveal secrets, every reveal audited; 8 MiB live read limit; hashes, not text, in the audit; no channel notice when a person edits; no client IP in the audit; loss of an unpublished **live** edit on a crash is accepted and shown as "not yet in the saved copy". Customer-account computers read the snapshot only; the overlay is not cheap there (L46) so they cannot be edited. | Closes the first revision's questions 2 to 11; section 14 lists what is still open. |

The numbers are this page's own (L1, L2, ...). D8, D9 and D14 of the design are unchanged and
used as stated: every enabled organization member reads and writes, the edit is direct with
a hash check and an audit record, audit retention is 90 days.

| # | Decision | Why |
| --- | --- | --- |
| L1 | **The routes of Phase 1 stay and grow.** `GET /orgs/{t}/computer/files`, `/stat`, `/content` keep their paths, their `{ error, message }` error body and `Cache-Control: private, no-store`. Responses gain `source: "live"`, `stale`, `fallback_reason`, `modified_at`; content responses gain `revealed` and `editable`. New: `PUT .../files/content`, `POST .../files/reveal`, `POST .../files/watch`. | One API with a `source` field is the design's own rule (7.1). No second path. |
| L2 | **Live is chosen by one predicate**, `liveFileSourceOf`: `liveOwnerOf` is true, `ownerProtocolVersion >= 2`, the owner's last polled state is `idle`, `serving`, `publishing` or `draining`, `ownerStopApprovedAt` is unset and `hydrateRequired` is false. Otherwise the answer comes from the snapshot. | W1, W19. `pollState` is already stored on the worker item (`store/codecs/worker.ts`). |
| L3 | **A protocol version gate, not a drain.** `OWNER_FILE_REQUESTS_PROTOCOL_VERSION = 2`. The supervisor bumps its `OWNER_PROTOCOL_VERSION` to 2 in the same change that handles `file_requests`. The server delivers file requests only to an owner whose stored `ownerProtocolVersion` is 2 or more; an older owner is answered from the snapshot with `fallback_reason: "owner_too_old"`. `OWNER_MINIMUM_PROTOCOL_VERSION` stays 1. | An owner lives at most 50 minutes, so skew is bounded; the gate is two comparisons, not a fork of behavior. |
| L4 | **Provenance on every file response**: `source` (`live` or `snapshot`), `as_of` (live: the time of the answer; snapshot: `published_at`), `stale` (a live computer exists whose disk may differ from this answer), `fallback_reason` (null unless a live attempt was skipped or failed), and for `owner_warming` a `retry_after_ms`. A computer that is off answers `source: "snapshot"`, `stale: false`: the snapshot is the truth. | W17. The UI needs exactly three states: live, saved copy, saved copy while the computer is on. |
| L5 | **Editing has two paths and one rule.** `editable` is true when the content is UTF-8 text, fully loaded (`truncated: false`), at most 256 KiB, not masked unless revealed, **and a write path exists**: the response is `source: "live"`, or it is a snapshot answer for a computer whose overlay is writable (no valid seal, L33). The UI never offers an editor on a stale fallback of a running computer, or while the overlay is sealed. `If-Match` is judged against the **effective hash**: the owner's disk when live, otherwise the overlay entry over the snapshot (L32). | W15, W26. |
| L6 | **The panel signals with a watch ping**, `POST .../files/watch` `{ open: true }` every 15 seconds while the Files tab is visible, and `{ open: false }` when it is hidden or closed. The server stores `interactiveUntilAt` on the computer record (now + 45 s for `open: true`, now for `open: false`). Every queued file request also sets it. | W2. The poll request stays unchanged; the server answers the pace. |
| L7 | **The interactive pace is 1000 ms**, not the design's 500 ms: `OWNER_POLL_INTERACTIVE_MILLISECONDS = 1000`. While `interactiveUntilAt` is in the future, `next_poll_ms = min(normal pace, 1000)`, in the states that can serve files (`idle`, `serving`, `publishing`, `draining`). | W3: it is the same as the first-minute idle tier, costs about 0.7 cents an hour while a panel is open, and makes the average pickup 0.5 seconds. Decided by the owner (O3). |
| L8 | **One fixed result route**: `POST /orgs/{t}/host/owner/file-results`, the operation id in the body. It is added to `OWNER_COMPUTER_ROUTES`. | W5. |
| L9 | **A request has a delivery state.** `pending` (queued) becomes `delivered` (the poll handed it to the owner, a conditional write), `done` (result recorded) or `abandoned` (the Front Door gave up while it was still `pending`, a conditional write). An abandoned request is never delivered. For a delivered write the Front Door waits a further 7 seconds and then answers 504 `outcome_unknown`; the late result is still recorded and still audited. A delivered read that times out falls back to the snapshot. | W6. This is the dispatch lifecycle of OWNER_SUPERVISOR_PROTOCOL 6.3 applied to files. |
| L10 | **Rows are deleted by the code that reads them; TTL is a backstop.** The Front Door deletes a result item after it has read it. An abandoned item loses its `request` and `result` attributes in the same conditional update. `expires_at` (120 seconds after queueing) only bounds what a crash leaves behind, and **every reader treats an item past its `expires_at` as absent**. | W4. |
| L11 | **The idle stop is vetoed by a pending or delivered file request** (veto `file_operation_pending`), judged and approved with the same compare-and-set trick as a dispatch: the computer record carries `fileOperationId`, the id of the last queued request; the approval is conditional on it being unchanged. Queueing a request is conditional on the owner being live and no stop being approved. An approval and a queued request cannot both win. `lifetime` and `unhealthy` stops are not vetoed (the supervisor finishes the operation in flight and answers the rest `owner_stopping`). | W7. Mirrors OWNER_SUPERVISOR_PROTOCOL 5.4. |
| L12 | **Only genuine operations are activity, and nothing here starts a computer** (O2). A file operation through a live owner restarts an idle supervisor's idle clock when it finishes. An open panel, a watch ping, a read or a write answered from the snapshot, and an overlay edit are not activity and never queue a start job. | W7. |
| L13 | **A successful write schedules the quiet publish**: the supervisor sets its next publish check to at most 30 seconds from the write if it is idle or publishing, and at the next gap if a child runs. The response says `backed_up: false` so the UI can say the copy on the computer is not yet in the saved copy. | W8. Accepted by the owner (O4): an unpublished live edit is lost on a crash and the panel says so. |
| L14 | **The live path marks the disk dirty before it queues a write** (`markComputerDiskDirty`) and refuses a write when `hydrateRequired` is true. An overlay write touches no disk and sets no flag. | W9. A spurious dirty flag costs one index scan; a missing one loses an edit silently. |
| L15 | **The helper gets four bounded operations**: `list` (scans at most 20,000 names, returns at most 2,000 entries), `stat`, `read` (a range, at most 256 KiB, of a regular file of at most 8 MiB; hashes the whole file) and `write` (UTF-8 text up to 256 KiB, atomic, with a precondition). Opening is `O_NONBLOCK` and `fstat` must say regular file, so a FIFO or a device is `not_a_file`, not a hang. Each operation has a 6 second timeout enforced by the supervisor. | W10, W24. The 8 MiB cap is below the snapshot's 50 MiB (accepted: O4). |
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
| L30 | **The edit overlay is in the snapshot bucket**, under the computer's prefix: `overlay/index.json` and `overlay/blobs/{sha256}`. The pack is never rewritten. The Front Door alone writes and deletes overlay objects. | W26. S3 because the owner already reads that prefix with scoped credentials (no new store or role, no size limit on the way down), edits cost S3 requests only, and the content is at most 256 KiB per file. DynamoDB was considered (native conditions, but the supervisor has no table access by design and would need the content through a Lambda response). |
| L31 | **One object is the compare-and-swap target.** Blobs are content-addressed and immutable, written first (`If-None-Match: *`; an existing blob is fine). The index is replaced with `PutObject` `If-Match: <its ETag>` (`If-None-Match: *` for the first one). A lost swap re-reads and re-judges, at most 3 times. A half-finished write leaves an unreferenced blob and nothing else. | S3 conditional writes (`IfMatch`, `IfNoneMatch`; `@aws-sdk/client-s3` 3.1146 supports both). ASSUMPTION: moto 5.2.3 (`package.json` `moto:start`) honors both; part A3 proves it first and the store port has a filesystem implementation with the same semantics for scenarios. |
| L32 | **Effective hash** of a path = the overlay entry's `sha256` if there is a non-conflicting entry, else the snapshot index's `sha256`, else absent. `If-Match` and `If-None-Match` are judged against it. An entry carries `base_sha256`, the snapshot hash the **first** edit of the path started from (null for a create); later edits of the same path keep it. | Lets the apply step tell "the disk still has what the person started from". |
| L33 | **The overlay is writable if and only if it has no valid seal.** A seal `{ owner_id, generation, sealed_at, snapshot_generation }` is valid when the computer record's `ownerId` and `ownerGeneration` equal it **and** `liveOwnerOf` holds. Otherwise the seal is stale and the next writer replaces it. While a valid seal exists edits go to the owner (live path, 7.3); if the owner cannot serve yet the answer is 503 `computer_starting`, if it is stopping 503 `computer_stopping`, each with `retry_after_ms`, and the panel keeps the text. | The seal is the single linearization point of every race in 7.7.6. |
| L34 | **The owner seals, then applies the sealed set, before it reports idle.** In `hydrate()`, after extraction: seal (Front Door compare-and-swap, returns the entries), apply each entry through the file helper, report. No turn is dispatched while the supervisor is hydrating (`considerDispatch` ignores a dispatch unless the state is `idle`), so no turn runs before the apply ends. The apply has a budget of 30 seconds; past it, or on an unreadable blob or index, the supervisor treats it as a hydrate failure (exit 8) rather than let the agent run on a disk missing edits the person saw. The agent waits for nothing else. | Readiness per capability: the only wait is the owner's own file application. |
| L35 | **Applying uses the helper, as uid 2000, with the precondition.** Each entry is a helper `write` with `if_match base_sha256` (or `if_none_match` for a create) and `refuseGitSegments`. `ok` means applied. `precondition_failed` whose `current_sha256` equals the entry's `sha256` means already applied (covered). Any other current hash is a **conflict**: the entry is not applied and is reported (L39). Root never opens a workspace path. | The same containment as every other file operation (12.2). |
| L36 | **An entry is cleared only after a publish that began after it was applied, and the control plane has recorded.** The supervisor keeps the set it applied; when a publish starts it captures the set, and after `publishComputerSnapshot` succeeds it posts `cleared` for exactly that set. A lost post is retried every `OVERLAY_CLEAR_RETRY_SECONDS` and before the stopped report. If after the apply the disk equals the published index (nothing to publish), the set is cleared at once. After applying, the next publish check is scheduled `OVERLAY_EARLY_PUBLISH_SECONDS` (5) after the supervisor becomes idle instead of 600; while a child runs the publish still waits (C14) and the entries stay. | W30. Until the clear, a crash loses nothing: the overlay still holds every edit. |
| L37 | **The supervisor never writes or deletes overlay objects; the Front Door performs the clear.** The supervisor reports `cleared` (path, revision, sha256) at `POST /host/owner/overlay-applied`; the Front Door removes exactly the entries that still match, while the seal is valid, **and only if a publish is on record**: the computer's `snapshotGeneration` is greater than the seal's, or the snapshot index already holds the entry's hash for the path. The route checks it; it does not trust the owner's word. The supervisor role gets an explicit **deny** of `PutObject`, `DeleteObject` and `DeleteObjectVersion` on the overlay prefix. | IAM cannot say "delete only applied entries"; a route can. One writer, no standing delete right on a long-lived credential. |
| L38 | **The seal ends with the owner.** The stopped report unseals (best effort, one compare-and-swap). A seal whose owner is no longer the live owner is stale, and the next overlay write, seal or discard replaces it. Entries are never lost by an unseal. | Crash and lease takeover (7.7.6). |
| L39 | **A conflict is never resolved silently.** A conflict exists when a path has an entry and the snapshot hash is neither the entry's `base_sha256` nor its `sha256` (derived at every read), or when the owner found a third hash on the disk while applying (stored: `conflict` on the entry). The effective content is the snapshot's (theirs); the person's text stays readable as `variant=mine`; the owner never applies an entry with a conflict. Resolution is explicit: a `PUT` with `If-Match` of theirs replaces the entry (the person overwrote on purpose; new `base_sha256` is theirs), or `POST .../files/overlay/discard`. | The owner's rule: refuse and surface, never overwrite. |
| L40 | **The overlay accepts only what the next publish will keep.** Refused: a path with a segment in `PACK_EXCLUDED_DIRECTORY_NAMES` (422 `not_in_saved_copy`), a path whose snapshot entry is a symlink or directory or one of whose ancestors is a symlink (403 `path_refused` / 422 `not_a_file`), a `.git` segment, a parent directory that is absent from the snapshot index (404 `parent_missing`; `/workspace` always exists), anything over the size caps. No directory is created. | W31. |
| L41 | **Caps:** 100 entries, 8 MiB of content in total, 256 KiB per file, an index of at most 256 KiB. Beyond them 409 `overlay_full`. | Bounds the apply time (L34) and the Lambda memory. |
| L42 | **The apply runs after every hydrate** whether or not the cache matched, and also when there is no snapshot (an empty workspace). It is independent of extraction. | W29. |
| L43 | **Every snapshot answer merges the overlay** (list, stat, content, reveal), including the stale fallbacks of a running computer. A computer with no snapshot answers an empty `/workspace` plus the overlay. Masking by name applies to overlay content. A live answer ignores the overlay. | W34. |
| L44 | **Audit for the overlay** uses the same record (section 7.1) with `source: "overlay"`; operations `write`, `create`, `discard`, and `overlay_apply` (written by the Front Door when the owner reports a clear or a conflict; `user_id` is the entry's `edited_by`, plus `owner_id`). Intent first, fail closed, as L21. | D14. |
| L45 | **An overlay edit changes no computer record**, queues no request, sets no flag and starts nothing. | O2. |
| L46 | **Customer-account computers have no overlay.** Their snapshot bucket is in the customer's account and their host worker has no supervisor to apply it. Reads are the snapshot; an edit is 409 `edit_unsupported`. Making it cheap would mean teaching the host worker to apply, which is a separate decision (Q-O4). | W33, O4. |
| L47 | **A running owner of protocol 1 blocks edits** with 409 `owner_too_old` for the rest of its life (at most 50 minutes): it would never apply an overlay, and its publish would produce false conflicts. Reads are served as before from the snapshot with the overlay merged. | The version gate of L3 applied to writes. |

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
| `OVERLAY_MAX_ENTRIES`, `OVERLAY_MAX_TOTAL_BYTES`, `OVERLAY_INDEX_MAX_BYTES` (`edit-overlay.ts`) | 100, 8388608, 262144 | overlay writes (L41) |
| `OVERLAY_CAS_ATTEMPTS` | 3 | Front Door index swaps |
| `OVERLAY_APPLY_BUDGET_SECONDS` | 30 | supervisor (L34) |
| `OVERLAY_SEAL_RETRY_AFTER_MILLISECONDS` | 2000 | `computer_starting` answers |
| `OVERLAY_STOPPING_RETRY_AFTER_MILLISECONDS` | 5000 | `computer_stopping` answers |
| `OVERLAY_CLEAR_RETRY_SECONDS` | 10 | supervisor (L36) |
| `OVERLAY_EARLY_PUBLISH_SECONDS` | 5 | supervisor (L36) |
| `OVERLAY_INDEX_OBJECT`, `overlayBlobObject(sha256)` | `overlay/index.json`, `overlay/blobs/{sha256}` | all |

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
		/** "pending": an overlay edit is in effect; "conflict": the person's edit conflicts with a newer snapshot (the entry shows theirs). */
		overlay: z.enum(["none", "pending", "conflict"]),
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
	overlay: z.enum(["none", "pending", "conflict"]),
	mine_sha256: sha256Hex.nullable().optional(),
});

/** PUT /orgs/{tenant}/computer/files/content?path=  with If-Match: "<sha256>" or If-None-Match: *  */
export const liveFileWriteBodySchema = z.object({ content: liveFileTextSchema }).strict();

export const liveFileWriteResponseSchema = z.object({
	source: z.enum(["live", "overlay"]),
	as_of: timestamp,
	path: livePathSchema,
	created: z.boolean(),
	size: z.number().int().nonnegative(),
	sha256: sha256Hex,
	previous_sha256: sha256Hex.nullable(),
	modified_at: timestamp,
	kept_as: livePathSchema.nullable(),
	/** false for a live edit (on the computer's disk, not yet in the saved copy); true for an overlay edit (already part of the saved copy as the next read sees it). */
	backed_up: z.boolean(),
});

/** POST /orgs/{tenant}/computer/files/reveal */
export const liveFileRevealBodySchema = z
	.object({
		path: livePathSchema,
		offset: z.number().int().min(0).optional(),
		length: z.number().int().min(1).max(LIVE_FILE_CONTENT_MAX_BYTES).optional(),
	})
	.strict();

/** POST /orgs/{tenant}/computer/files/overlay/discard: drop the person's own pending overlay edit (sha256 is the entry's). */
export const liveFileDiscardBodySchema = z.object({ path: livePathSchema, sha256: sha256Hex }).strict();

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

// ownerErrorCodeSchema gains "operation_closed" and "overlay_not_sealed"; OWNER_ERROR_STATUS maps both to 409.
// ownerStopVetoReasonSchema gains "file_operation_pending".
// ownerPollResponseSchema gains, beside dispatches:
//   file_requests: z.array(ownerFileRequestSchema).max(LIVE_FILE_MAX_REQUESTS_PER_POLL).default([]),
// The two refinements (drain_reason, no dispatch while draining) are unchanged; file_requests are allowed while draining.
```

`OWNER_PROTOCOL_VERSION` stays 1 in F0. **Part C** changes it to 2 in the same pull request that
makes the supervisor handle `file_requests` (L3). `ownerPollRequestSchema` is unchanged.

### 5.4 Owner error codes

`overlay_not_sealed` (409): the overlay is not sealed by this owner and generation (it was never sealed, or a newer
owner replaced the seal). `operation_closed` (409): the request was abandoned, expired, answered already with a
different result, never delivered to this owner, or belongs to another computer. The
supervisor drops the operation on it. The existing rules for 401, 403 and 409 `stale_poll`
of OWNER_SUPERVISOR_PROTOCOL 9.5 apply to the new route unchanged: a 401 or a superseding 403 ends the supervisor.

### 5.5 `host-protocol/src/edit-overlay.ts` (revision 2)

```ts
import { z } from "zod";
import { livePathSchema } from "./live-files.ts";

export const OVERLAY_INDEX_VERSION = 1;
export const OVERLAY_MAX_ENTRIES = 100;
export const OVERLAY_MAX_TOTAL_BYTES = 8388608;
export const OVERLAY_INDEX_MAX_BYTES = 262144;
export const OVERLAY_CAS_ATTEMPTS = 3;
export const OVERLAY_APPLY_BUDGET_SECONDS = 30;
export const OVERLAY_SEAL_RETRY_AFTER_MILLISECONDS = 2000;
export const OVERLAY_STOPPING_RETRY_AFTER_MILLISECONDS = 5000;
export const OVERLAY_CLEAR_RETRY_SECONDS = 10;
export const OVERLAY_EARLY_PUBLISH_SECONDS = 5;
export const OVERLAY_INDEX_OBJECT = "overlay/index.json";
export const overlayBlobObject = (sha256: string): string => `overlay/blobs/${sha256}`;

const identifier = z.string().min(1).max(256);
const timestamp = z.iso.datetime();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** A conflict found by the owner while applying: the disk held a third version. Derived conflicts (the snapshot moved) are not stored. */
export const overlayConflictSchema = z.object({ disk_sha256: sha256Hex.nullable(), found_at: timestamp }).strict();

/** One edited file. The content is the blob named by `sha256`. */
export const overlayEntrySchema = z
	.object({
		path: livePathSchema,
		sha256: sha256Hex,
		size: z.number().int().nonnegative().max(262144),
		mode: z.string().regex(/^[0-7]{3,4}$/),
		base_sha256: sha256Hex.nullable(),
		edited_by: identifier,
		edited_at: timestamp,
		revision: z.number().int().positive(),
		conflict: overlayConflictSchema.nullable(),
	})
	.strict();

/** Who may write the index: nobody but the Front Door; and not at all while a valid seal exists. */
export const overlaySealSchema = z
	.object({ owner_id: identifier, generation: z.number().int().positive(), sealed_at: timestamp, snapshot_generation: z.number().int().nonnegative() })
	.strict();

/** The object `overlay/index.json`. Paths are unique; the contents add up to at most 8 MiB. */
export const overlayIndexSchema = z
	.object({
		version: z.literal(OVERLAY_INDEX_VERSION),
		sealed: overlaySealSchema.nullable(),
		entries: z.array(overlayEntrySchema).max(OVERLAY_MAX_ENTRIES),
	})
	.strict()
	.refine((index) => new Set(index.entries.map((entry) => entry.path)).size === index.entries.length, { message: "paths are unique" })
	.refine((index) => index.entries.reduce((total, entry) => total + entry.size, 0) <= OVERLAY_MAX_TOTAL_BYTES, { message: "content over 8 MiB" });

/** POST /orgs/{tenant}/host/owner/overlay-seal: after extraction, close the overlay to member writes and get the entries to apply. */
export const ownerOverlaySealRequestSchema = z.object({ owner_id: identifier, generation: z.number().int().positive() }).strict();
export const ownerOverlaySealResponseSchema = z.object({ entries: z.array(overlayEntrySchema).max(OVERLAY_MAX_ENTRIES) });

const entryReference = z.object({ path: livePathSchema, revision: z.number().int().positive(), sha256: sha256Hex }).strict();

/**
 * POST /orgs/{tenant}/host/owner/overlay-applied: after a publish that began after the apply, clear exactly these entries;
 * and/or report entries that were not applied because the disk held a third version.
 */
export const ownerOverlayAppliedRequestSchema = z
	.object({
		owner_id: identifier,
		generation: z.number().int().positive(),
		cleared: z.array(entryReference).max(OVERLAY_MAX_ENTRIES).default([]),
		conflicts: z.array(entryReference.extend({ disk_sha256: sha256Hex.nullable() })).max(OVERLAY_MAX_ENTRIES).default([]),
	})
	.strict();
export const ownerOverlayAppliedResponseSchema = z.object({ remaining: z.number().int().nonnegative() });

export type OverlayIndex = z.infer<typeof overlayIndexSchema>;
export type OverlayEntry = z.infer<typeof overlayEntrySchema>;
```

A schema test proves: a 101st entry fails, duplicate paths fail, 8 MiB plus one byte fails, an entry with a path
outside `/workspace` fails, `cleared` and `conflicts` default to empty, and an index with a seal parses.

## 6. Routes

### 6.1 Owner routes (audience `computer-owner`)

| Method and path | Request | Response (200) | Refusals |
| --- | --- | --- | --- |
| `POST /orgs/{t}/host/owner/poll` (changed) | `ownerPollRequestSchema` (unchanged) | `ownerPollResponseSchema` with `file_requests` | as before |
| `POST /orgs/{t}/host/owner/file-results` (new) | `ownerFileResultRequestSchema` | `ownerFileResultResponseSchema` | 401, 403 as every owner route; 409 `operation_closed`; 422 `invalid_request`; 503 when the audit or request store write fails (the supervisor retries) |
| `POST /orgs/{t}/host/owner/overlay-seal` (new) | `ownerOverlaySealRequestSchema` | `ownerOverlaySealResponseSchema` (the entries to apply) | 401, 403 as every owner route; 422; 503 when the overlay store cannot be written (the supervisor retries inside its budget) |
| `POST /orgs/{t}/host/owner/overlay-applied` (new) | `ownerOverlayAppliedRequestSchema` | `ownerOverlayAppliedResponseSchema` | 401, 403 as every owner route; 409 `overlay_not_sealed`; 422; 503 (the supervisor retries) |
| `POST /orgs/{t}/host/owner/stop-request` (changed) | unchanged | `ownerStopResponseSchema`, a new veto `file_operation_pending` | as before |

The three new routes (`file-results`, `overlay-seal`, `overlay-applied`) are added to `OWNER_COMPUTER_ROUTES`. Authentication is section 5.1 of
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
| `GET /content?path=&offset=&length=&variant=` | as Phase 1; `variant=mine` (only for an entry in conflict) returns the person's version | `liveFileContentResponseSchema`, header `ETag: "<sha256>"` | masked: `masked: true`, no content |
| `PUT /content?path=` | `liveFileWriteBodySchema`; header `If-Match: "<effective sha256>"` **or** `If-None-Match: *` | `liveFileWriteResponseSchema`, header `ETag` | 7.3: to the owner when it is live, otherwise into the overlay (7.7.3) |
| `POST /reveal` | `liveFileRevealBodySchema` | `liveFileContentResponseSchema` with `masked: false, revealed: true`; `Cache-Control: no-store` | audited; both sources |
| `POST /watch` | `liveFileWatchBodySchema` | `liveFileWatchResponseSchema` | 7.5; starts nothing |
| `POST /overlay/discard` | `liveFileDiscardBodySchema` | `{ "discarded": true }` | 7.7.3; audited; only while the overlay is writable |

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
| `computer_starting` | 503 | the overlay is sealed and the owner cannot serve yet; carries `retry_after_ms` (2000); the text is kept |
| `computer_stopping` | 503 | the owner is stopping; carries `retry_after_ms` (5000) |
| `owner_too_old` | 409 | a running owner of protocol 1 would never apply an overlay (L47) |
| `edit_unsupported` | 409 | a customer-account computer (L46) |
| `overlay_full` | 409 | 100 entries or 8 MiB (L41) |
| `not_in_saved_copy` | 422 | the path is under a directory the snapshot never keeps (L40) |
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
on a write becomes 503 `computer_stopping`, `owner_busy` becomes 429 `too_busy`, `expired`
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
| `operation` | S | `write` (replace), `create`, `reveal`, `discard`, `overlay_apply` |
| `path` | S | the normalised path the person named |
| `resolved_path` | S | as reported by the owner, absent until the result arrives |
| `source` | S | `live`, `snapshot` (a reveal from the snapshot) or `overlay` (an edit or discard of a pending edit; a reveal of an overlay file) |
| `owner_id` | S | only for `overlay_apply`: the owner that applied or found a conflict |
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
3. Snapshot: the Phase 1 service with the provenance fields added and the **overlay merged over it** (7.7.2).
   A computer with no snapshot answers an empty `/workspace` plus the overlay; `no_snapshot` (404) only when
   there is neither. A live-eligible computer never reaches here.
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

One request, two paths: the owner when it can serve, the overlay otherwise. First failure wins.

1. Principal: `kind === "user"`, `userId !== null`, enabled organization (L24). 403 otherwise.
2. Write rate counter (429). Parse the precondition headers (428, 400). Parse the body with `liveFileWriteBodySchema` (400 `invalid_body`; a body over 256 KiB is 413 `content_too_large`, checked from `Content-Length` first and again after parsing).
3. `livePathProblem` (400). The normalised path has a `.git` segment: write the audit record with outcome `refused`, `error_code path_refused`, answer 403. (A refusal is audited, L29.)
4. **Route.** Read the computer record and the owner's worker item. First match wins:
   1. The organization is a customer-account organization: 409 `edit_unsupported` (L46).
   2. `liveFileSourceOf` is `live` (L2): the **live path**, steps 5 to 12 below.
   3. A live owner (`liveOwnerOf`) with protocol version below 2: 409 `owner_too_old` (L47).
   4. A live owner that is `stopping` or has `ownerStopApprovedAt`, and the overlay is sealed by it: 503 `computer_stopping`.
   5. A live owner that is booting or hydrating: read the overlay index; sealed by it: 503 `computer_starting`; not yet sealed: the **overlay path** (7.7.3).
   6. No live owner (off, lapsed heartbeat, `hydrateRequired`, any stale seal): the **overlay path** (7.7.3).
   None of these refusals is audited (nothing was attempted).

The live path:

5. Fewer than 16 open requests (429 `too_busy`).
6. `expected pickup` (L27): too slow: set the interactive window and answer 503 `owner_warming` with `retry_after_ms`; nothing is queued and nothing is audited. The UI keeps the person's text and asks again at that time.
7. Write the audit record, `outcome: "pending"` (L21). If the write fails: 503 `audit_unavailable`, nothing queued.
8. `markComputerDiskDirty` (L14).
9. Queue the request (transaction of 7.2 step 4.3). Canceled (the owner stopped in between): finalize the audit record `failed`/`owner_stopping`, answer 503 `computer_stopping`.
10. Wait (7.2 step 4.4). On `done` delete the item and map the outcome:
    * `ok` write: 200, `liveFileWriteResponseSchema` with `source: "live"`, `ETag: "<sha256_after>"`, `backed_up: false`.
    * error `precondition_failed` or `already_exists`: 409 with `current_sha256`.
    * the other owner errors per 6.3.
11. Timeout: `pending -> abandoned` conditional update. Won: 504 `owner_timeout`, nothing happened, the audit record is finalized `failed`. Lost because the status is `delivered`: wait up to 7 more seconds (`LIVE_FILE_OUTCOME_GRACE_MILLISECONDS`); still nothing: set `waiter_gone` on the item (conditional on `delivered`) and answer 504 `outcome_unknown`. The audit record stays `pending` and becomes `ok` or `failed` whenever the result route hears the owner.

The **result route** (7.4) finalizes the audit record of a live write. The waiting handler never writes the outcome, so
a late result is still recorded. A create (`If-None-Match: *`) is audited as `create`; a replace as `write`.

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
is not audited (so a forgotten panel does not keep the computer awake, L12, O2).

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

### 7.7 The edit overlay (revision 2)

#### 7.7.1 Objects

In the computer's snapshot prefix, `tenants/{T}/computers/{K}/`:

| Object | Content | Written by |
| --- | --- | --- |
| `overlay/index.json` | `overlayIndexSchema` (5.5): `sealed`, and one entry per edited path with `sha256`, `size`, `mode`, `base_sha256`, `edited_by`, `edited_at`, `revision`, `conflict` | the Front Door, only, by compare-and-swap (L31) |
| `overlay/blobs/{sha256}` | the UTF-8 text of one version, at most 256 KiB | the Front Door, only, `If-None-Match: *`; deleted by the Front Door when no entry names it |

The supervisor reads them (its role already allows `GetObject` on the prefix) and is denied every write (12.8). Nothing in the
overlay names a path in an S3 key: blobs are addressed by hash, so no member-chosen string becomes a key.

#### 7.7.2 The effective view

Inputs: the snapshot index (an empty one holding only the directory `/workspace` when nothing was published) and the overlay
index (a conditional `GET` with the cached `ETag`; an absent object is an empty overlay). For each path with an entry `E`, and `s` the
snapshot hash of the path (absent is a value):

| Condition | State | Shown as |
| --- | --- | --- |
| `s == E.sha256` | applied (the snapshot already holds the edit; the entry waits to be cleared) | the snapshot, `overlay: "none"` |
| `E.conflict == null` and `s == E.base_sha256` (both absent counts) | pending | the entry: `overlay: "pending"`, size, `sha256`, `mode`, `modified_at = edited_at` |
| anything else, or `E.conflict != null` | conflict | the snapshot (absent if `s` is absent), `overlay: "conflict"`, `mine_sha256 = E.sha256` |

* **List**: the snapshot's children of the directory, plus the pending and applied-looking entries whose parent is the directory
  and which the snapshot lacks (new files); same order and the same 2000 cap.
* **Stat, content, reveal**: a pending entry is served from its blob; the bytes are hashed and must equal `E.sha256` (else 500
  `corrupt_snapshot`, logged). `variant=mine` serves the blob of an entry in conflict. Masking and binary sniffing are the snapshot's.
* **Effective hash** (L32) is the shown `sha256`: the entry's when pending, otherwise the snapshot's. This is the `ETag`.
* A write whose content hash equals the effective hash is a no-op: 200, nothing written, no audit record.

#### 7.7.3 Writing, discarding

Reached from 7.3 step 4.5 or 4.6. Steps, first failure wins:

1. Path rules (L40) against the snapshot index: a segment in `PACK_EXCLUDED_DIRECTORY_NAMES` is 422 `not_in_saved_copy`; the path or an
   ancestor is a symlink in the index, 403 `path_refused`; the path is a directory, 422 `not_a_file`; the parent directory is not in the index
   (and is not `/workspace`), 404 `parent_missing`.
2. `GET overlay/index.json` (ETag `E`, or absent), parsed with `overlayIndexSchema`. A **valid seal** (L33) was already handled by 7.3 step 4; a seal
   that is present but stale is carried into step 7 and cleared by the swap.
3. Judge the precondition against the effective hash (7.7.2). `If-Match` differs: 409 `precondition_failed` with `current_sha256`
   (the snapshot's for a conflicted path). `If-None-Match: *` and the path exists in the effective view: 409 `already_exists`.
4. Caps (L41): the entry count after the write and the sum of sizes: else 409 `overlay_full`.
5. Write the audit record (`source: "overlay"`, `outcome: "pending"`); 503 `audit_unavailable` if it cannot, nothing written.
6. `PUT overlay/blobs/{sha256}` with `If-None-Match: *`; a 412 means it exists and is fine.
7. Build the new index: the entry `{ path, sha256, size, mode, base_sha256, edited_by, edited_at, revision, conflict: null }` where
   `mode` is the existing entry's, else the snapshot entry's, else `"664"`; `base_sha256` is the existing entry's, else the snapshot hash
   of the path (null for a create), and **the snapshot hash when the existing entry was in conflict** (the person overwrote on purpose);
   `revision` is the old one plus 1, else 1; `sealed: null`. `PUT overlay/index.json` with `If-Match: E` (`If-None-Match: *` when absent).
8. A failed swap (412): re-read and go back to step 3, at most `OVERLAY_CAS_ATTEMPTS` (3) times; a changed effective hash is the 409 of step 3.
9. Finalize the audit record `ok`; delete the replaced blob if no entry names it (best effort); answer 200, `liveFileWriteResponseSchema` with
   `source: "overlay"`, `backed_up: true`, `ETag: "<sha256>"`.

**Discard** (`POST .../overlay/discard`): principal, write counter, path, 7.3 step 4 (so a sealed overlay is 503), read the index; the entry must exist with
this `sha256` (409 `precondition_failed` otherwise); audit record (`operation: "discard"`); swap the entry out (same loop); delete its blob. Any
enabled member may discard (the workplace is shared and every discard is audited).

#### 7.7.4 The owner: seal, apply, clear

In the supervisor's `hydrate()` (section 9.4), in this order and before the supervisor leaves `hydrating`:

1. Extract the snapshot and share the workspace with the shell user (existing). Also when the local cache matched, and also when there is
   no snapshot (L42).
2. `POST overlay-seal`. The Front Door authenticates the owner (section 5.1 of the supervisor contract), reads the index, and writes it with
   `sealed = { owner_id, generation, sealed_at, snapshot_generation }` (the computer record's `snapshotGeneration` at that moment) by compare-and-swap (creating it with `If-None-Match: *` if absent). A seal already held by this owner
   and generation is returned as is (a retry). A seal of anyone else is stale by construction (this owner is the live owner) and is replaced. A lost
   swap re-reads: a member edit that won the swap is in the set. The response carries every entry.
3. Apply, in path order, every entry without a stored `conflict`: read its blob from S3, check the bytes hash to `entry.sha256`, and call the file helper
   `write` with `if_match base_sha256` (`if_none_match` when `base_sha256` is null) and `refuseGitSegments`. `ok`: applied. `precondition_failed` whose
   `current_sha256` equals `entry.sha256`: already applied. Any other outcome of `precondition_failed` or `already_exists`: **conflict**. A blob that cannot
   be read or does not hash, or a helper failure other than those, fails the hydrate (L34).
4. If there are conflicts, `POST overlay-applied { conflicts }`. The Front Door stores `conflict: { disk_sha256, found_at }` on each entry whose `revision`
   still matches, and writes an `overlay_apply` audit record with outcome `conflict`. Failing this post is logged and retried; it does not fail the hydrate.
5. Remember the applied set. If the disk now equals the published index (nothing to publish) go to 7 at once.
6. Return from `hydrate()`; the supervisor is idle. The first publish check is 5 seconds later (L36). A turn that arrives first runs; the entries stay.
7. When a publish starts, capture the applied set; after `publishComputerSnapshot` succeeds, `POST overlay-applied { cleared }` for that set. The Front Door removes
   each entry whose `path`, `revision` and `sha256` match and for which a publish is on record (the rule of L37; an entry without one simply stays, and `remaining` says so), deletes blobs no entry names, writes `overlay_apply` records (outcome `ok`), and answers `remaining`.
   Entries not named stay. A failed post is retried every 10 seconds and before the stopped report.

The seal ends with the owner: the stopped report unseals (one swap). A seal left by a dead owner is stale (L38).

#### 7.7.5 Transitions

| From | To | Overlay writes | Reads | What happens |
| --- | --- | --- | --- | --- |
| Off | Starting (the starter ran, no bootstrap yet) | accepted into the overlay | snapshot + overlay | nothing about the overlay; nothing started by an edit |
| Starting | Hydrating (bootstrap done, extracting) | accepted (no seal yet) | snapshot + overlay, stale `owner_not_ready` | edits made now are in the sealed set |
| Hydrating | Sealed and applying | 503 `computer_starting`, retry in 2 s | snapshot + overlay | seal swap; apply; no turn can run |
| Applying | Live (idle) | through the owner | the owner | entries stay until a publish that began after the apply is recorded |
| Live | Live after publish and clear | through the owner | the owner | entries removed; blobs deleted |
| Live | Stopping (stop approved) | 503 `computer_stopping`, retry in 5 s | snapshot + overlay (stale `owner_stopping`) | final publish, final clear, stopped report unseals |
| Stopping | Off | accepted into the overlay | snapshot + overlay | normal |
| Live or hydrating | Crash (no stopped report) | for up to 30 s the owner still looks live; then accepted | for up to 30 s as live; then snapshot + overlay | the seal is stale once the heartbeat lapses; entries were not cleared, so nothing is lost; live-only edits since the last publish are lost (accepted, O4) |
| Live | Replaced (a newer generation while the old one lingers) | accepted until the new owner seals | snapshot + overlay | the new owner's seal replaces the stale one; the old owner's calls are refused (403 `stale_generation`) and its S3 writes are denied by IAM |
| Live, protocol 1 | any | 409 `owner_too_old` | snapshot + overlay (stale `owner_too_old`) | until it stops |
| Customer-account computer | any | 409 `edit_unsupported` | snapshot | no overlay exists |

#### 7.7.6 The races, exactly

* **R1, an edit against the seal.** Both are compare-and-swaps of `overlay/index.json`. The one that swaps first wins. An edit that loses re-reads, sees the seal and answers
  503 `computer_starting` (an unreferenced blob remains); an edit that won is in the set the seal returns. There is no third outcome.
* **R2, an edit while the snapshot is being extracted.** The seal is written after extraction, so the edit is in the sealed set and is applied before any turn.
* **R3, two members editing while off.** Each judges against the effective hash it read; the second swap fails if the first changed the index; it re-reads and re-judges.
  The same path with a now-stale `If-Match`: 409 with the first member's hash. Different paths: both stand.
* **R4, the apply against a live edit.** No file operation is delivered before the supervisor leaves `hydrating` (the poll delivers only in `idle`, `serving`, `publishing`,
  `draining`). The clear names `path`, `revision` and `sha256` that were applied, never what the disk holds now.
* **R5, a lost clear.** Nothing is removed until the control plane records it. An applied entry that stays is idempotent at the next hydrate (the disk equals the entry: already
  applied). Only if the bot also changed the file in a later successful publish **and** the clear was lost until the next hydrate does the owner find a third hash and report a
  conflict; that false conflict needs two failures in a row and is surfaced, not resolved silently. The supervisor retries every 10 seconds and before the stopped report to make it rare.
* **R6, a takeover in the middle of the apply.** The new owner seals again (the old seal is stale, replacing it is one swap) and applies from the snapshot on its own disk. The old
  owner's disk is not the new one's.
* **R7, a snapshot published by something that does not know the overlay** (a customer host, a protocol 1 owner): the entry is a derived conflict at the next read and a stored
  conflict at the next apply. The person's text is kept and readable; nothing is overwritten.
* **R8, a discard against the seal.** The same compare-and-swap as R1.
* **R9, the audit.** The record is written before the blob and the swap, so every accepted edit has a record; one for an edit that then lost a swap is finalized `failed`.

#### 7.7.7 Size and cost

Caps in L41. Cost in section 19.

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

### 9.4 The overlay at hydrate (revision 2)

Files: `computer/host/src/overlay-applier.ts` (new), `host-disk-lifecycle.ts`, `supervisor.ts`, `supervisor-ports.ts`, `protocol-client.ts`, `supervisor-main.ts`. The applier uses the
same `FileHelperLauncher` as the file runner (9.1); it never opens a workspace path itself.

```ts
export interface OverlayApplier {
	/** Seal the overlay, apply its entries through the file helper, report conflicts. Resolves with the entries now on the disk. Throws OverlayApplyError (the hydrate fails, exit 8). */
	applyAfterHydrate(): Promise<{ readonly applied: readonly OverlayEntryReference[]; readonly conflicts: readonly OverlayEntryReference[] }>;
	/** After a recorded publish: ask the Front Door to clear exactly these entries; true when acknowledged. */
	clearApplied(entries: readonly OverlayEntryReference[]): Promise<boolean>;
}
```

* `SupervisorPlane` gains `sealOverlay(request)` and `postOverlayApplied(request)` (`OwnerSupervisorClient`, same headers and error handling as `poll`).
* `HostDiskLifecycle.hydrate()`: after `bootThroughWorkspace()` and `afterHydrate` (the group sharing that lets uid 2000 write), call
  `applyAfterHydrate()` inside the budget of `OVERLAY_APPLY_BUDGET_SECONDS`; the entries it applied are returned to the supervisor.
* `OwnerSupervisor`: keeps `appliedAwaitingClear`. In `beginHydration`, after `disk.hydrate()`, sets
  `nextPublishCheckAtMilliseconds` to now + `OVERLAY_EARLY_PUBLISH_SECONDS` when entries were applied (else the 600 second default of today). `beginPublishCycle` and the final publish of `performStop`
  capture the set before the pack starts and call `clearApplied` after `publishChangedDisk` succeeds; `needsPublish() === false` right after the apply clears at once. A failed clear is retried on the
  10 second tick (`OVERLAY_CLEAR_RETRY_SECONDS`) and up to 3 times before the stopped report; it never blocks the stop.
* Failure rules: a 401 or a superseding 403 on either route ends the supervisor as superseded (as for a poll); a 5xx or a network error on the seal is retried inside the 30 second budget, then
  `snapshot_skipped reason=overlay_failed` and exit 8; a blob that cannot be read or does not hash to its entry, or a helper failure other than `precondition_failed`, is the same.
* Logs (no path, no content): `overlay_sealed` (`entries`), `overlay_applied` (`applied`, `already`, `conflicts`, `duration_ms`), `overlay_clear_requested` (`entries`), `overlay_cleared` (`remaining`),
  `overlay_apply_failed` (`reason`).

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
| Computer off | `source: "snapshot"`, `stale: false` | `Computer is off. Showing the copy saved <relative time>` (today's `SavedCopyNote` wording with the time); **the editor is offered** (the edit goes into the overlay); a file with `overlay: "pending"` shows `Edited, waiting for the computer` |
| Fallback | `source: "snapshot"`, `stale: true` | `Could not reach the running computer. Showing the saved copy from <time>` with a Retry button; the panel asks again after `retry_after_ms` (default 2 seconds), three times, then waits for a click; no editor |
| Starting | watch `state: "starting"` | `The computer is starting. Showing the saved copy` |
| Warming | `fallback_reason: "owner_warming"` | `Connecting to the running computer` (not an error), asks again at `retry_after_ms` |

`FileListing.source` and `FileContentRange.source` widen to `"snapshot" | "live"`; both gain `stale`, `fallback_reason`,
`retry_after_ms?`; content gains `revealed`, `editable`, `modified_at`, `overlay`, `mine_sha256?`; an entry gains `modified_at` and `overlay`. The write response gains `source: "overlay"` and a boolean `backed_up`.

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
  status reads `Saving`. 200 with `source: "live"`: `Saved on the computer`, with the line `Not yet in the saved copy` (`backed_up` is false);
  200 with `source: "overlay"`: `Saved. Your change will be applied when the computer starts`, with no line about the saved copy (`backed_up` is true). The new
  `sha256` becomes `loadedSha256` and the file leaves edit mode.
  `kept_as` present: a notice `A change made at the same moment was kept as <name>`.
* **New file**: in a live listing a `New file` button asks for a name (must not contain `/`), creates it with
  `If-None-Match: *` and an empty draft, and opens the editor. 409 `already_exists`: `A file with that name exists`.
* **Leaving** (Back to folder, opening another file, navigating, the tab switching away) with a changed draft asks `Discard your
  changes?` with `Keep editing` and `Discard`. Reload with unsaved changes asks the browser's own prompt.
* **Errors** keep the draft: `owner_warming` and `owner_timeout` (`Could not reach the computer; your text is kept`, Retry),
  `outcome_unknown` (`Not sure the save happened. Reload the file to check`, with a Reload button that reads the file and shows
  the conflict banner if it differs from the draft), `rate_limited`, `computer_starting` and `computer_stopping` (`The computer is starting; your text is kept`,
  tried again automatically after `retry_after_ms`, three times, then a Retry button), `owner_too_old` (`The computer is being updated; try again in a few minutes`),
  `overlay_full` (`Too many files were edited while the computer was off; start the computer or discard some`), `not_in_saved_copy` (`This folder is not kept in the saved copy`),
  `edit_unsupported` (`Files on this computer cannot be edited here`), `content_too_large`, `file_too_large`, `path_refused`, `precondition_required`
  (a bug, shown as a generic error).

### 10.5 The conflict banner

An overlay conflict (the content response says `overlay: "conflict"`) shows the same banner on open, with the text `Your edit conflicts with a newer version of this file`,
the saved version (`theirs`, the response) and the person's text (`variant=mine`), and the buttons `Overwrite with mine` (a `PUT` with `If-Match` of theirs), `Use theirs` (the discard route,
after the discard prompt) and `Copy mine`.

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

### 11.7 The overlay entry and the seal (revision 2)

```
(none) --member edit (swap)--> pending --member edit--> pending (revision + 1)
          pending --snapshot hash becomes entry hash (a publish by the owner)--> applied --clear (route)--> (none)
          pending --snapshot hash is neither base nor entry (a host that ignores the overlay)--> conflict
          pending|conflict --discard (swap)--> (none)
          conflict --member edit with If-Match of theirs (swap)--> pending (base = theirs)
          pending --owner finds a third hash on the disk--> conflict (stored)
```

```
unsealed --owner seal (swap)--> sealed(owner, generation, snapshot_generation)
sealed --stopped report (swap)--> unsealed
sealed --owner no longer live (heartbeat lapsed, newer generation)--> stale (replaced by the next seal or member write)
```

An entry is cleared only from the sealed state and only when a publish is on record (L37). Member writes happen only from `unsealed` or `stale`.

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
secret from its hash is possible; accepted (O4). Tokens never appear in file routes: the member's bearer is verified and dropped.

### 12.7 Findings, status

| Finding | Status |
| --- | --- |
| 1. Symlink escape in file tools | Holds. The new operations run in the same helper through the same launcher; the supervisor opens no path; a planted link scenario covers every new operation (`@supervisor` links, FIFO, `.git`). |
| 2. Invoke key reaches every owner | Holds. The new owner route takes only the supervisor token. |
| 4. Tenant-wide table reach | Holds. No role gains a statement; the two new key families are outside both. |
| Audit tampering (design 14) | Closed by the key families and the Front Door being the only writer. |
| 4, S3 reach (revision 2) | The per-turn role keeps no snapshot statement (OWNER_SUPERVISOR_PROTOCOL C4), so it cannot touch the overlay. The supervisor role gets an explicit deny of writes to the overlay prefix (12.8). The Front Door role gains write on that prefix only. |

### 12.8 The edit overlay (revision 2)

**Who may write.** The Front Door alone. Exact statements:

The Front Door role (CDK, `infra/lib/control-plane-stack.ts`, beside `ReadComputerSnapshots`; the bucket is the snapshot bucket):

```json
{
	"Sid": "WriteComputerEditOverlay",
	"Effect": "Allow",
	"Action": ["s3:PutObject", "s3:DeleteObject"],
	"Resource": ["arn:aws:s3:::SNAPSHOT_BUCKET/tenants/*/computers/*/overlay/*"]
}
```

`s3:GetObject` on `tenants/*/computers/*/*` and `s3:ListBucket` on the prefix already exist. Conditional puts need only `s3:PutObject`. `s3:DeleteObjectVersion` is not granted, so a delete leaves a
delete marker and the earlier version (see "Secrets" below).

The supervisor role (`conversation/src/gateway/supervisor-role-policy.json`, read as data by `infra/lib/owner-role-policy.ts` and evaluated by the scenarios): the existing
`SnapshotObjects` allow stays (`GetObject` covers reading the overlay; `PutObject` and `AbortMultipartUpload` are what the pack upload needs), and a second statement is added:

```json
{
	"Sid": "OverlayIsWrittenByTheFrontDoorOnly",
	"Effect": "Deny",
	"Action": ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectTagging", "s3:AbortMultipartUpload"],
	"Resource": ["{{snapshotBucketArn}}/tenants/${aws:PrincipalTag/tenant}/computers/${aws:PrincipalTag/computer}/overlay/*"]
}
```

An explicit deny wins over the allow whatever else is attached. The supervisor therefore **reads** the overlay and can neither write nor delete in it; it never holds a delete right at all. The
"delete only applied entries" of the brief is done by the Front Door at `overlay-applied`, which can check what IAM cannot: that the entry still matches by path, revision and hash, that the seal
is valid, and that a publish is on record (L37). `features-support/iam-policy-evaluator.ts` (type `Effect: "Allow"` only today) learns `Deny` with the rule that a matching deny overrides any allow;
`infra/lib/owner-role-policy.ts` passes `Effect` through. The per-turn role has no snapshot statement; the scenario proves it against `overlay/index.json` and a blob key.

**What a compromised supervisor (token and credentials) can do.** Read the overlay of its own computer (it holds the files anyway). Claim `cleared` for entries: refused unless the seal is its
own and a publish is on record; the worst case is clearing an entry whose publish it faked, which needs the disk it already controls. Report false `conflicts`: an entry the person sees as a
conflict, and nothing is lost (the person's text stays readable). Refuse to apply: the person's edit waits (availability). It cannot write, delete or replace an overlay object, cannot seal
for another computer (the route authenticates the owner and the key is built from the token's tenant and computer), and cannot read another computer's overlay (the role's prefix is tag-bound).

**Confused deputy.** The Front Door writes the overlay for a member into the prefix built from `principal.tenantId` and the computer record, never from the request; blob keys are
hashes; no member-chosen string is an S3 key. The owner applies entries through the file helper as uid 2000 with the base-hash precondition, `refuseGitSegments` and the containment check, so an
entry for `/workspace/leak` where `leak` is a link out of the workspace is a conflict, not a write (scenario "The overlay is applied through the file helper and cannot reach outside the workspace").
Root never opens a workspace path.

**Time of check to time of use.** The seal swap is the linearization point (R1). Between the owner's blob read and the helper write, the disk cannot change under it: no turn runs and
no file operation is delivered before the supervisor leaves `hydrating`. A blob is verified against its hash before it is written.

**Denial of service.** Caps (L41); 30 writes a minute a user (the write counter); at most 3 swap attempts per request; an index of at most 256 KiB read per request; an apply bounded to
30 seconds with the failure meaning "the owner does not start" rather than "the agent runs without the edits" (a person who keeps an overlay unreadable can only hurt their own organization's computer, and
the control plane's start lease and probes behave as for any hydrate failure).

**Secrets.** Overlay content is stored as plaintext objects under the bucket's managed encryption (`S3_MANAGED`, `enforceSSL`), deleted when cleared. The bucket is **versioned with no expiry of
non-current versions** (`infra/lib/snapshot-stack.ts`), so a deleted blob (an edited `.env`) remains recoverable by an administrator until someone adds a non-current-version expiry; that
is open question Q-O3. Masking by name applies to overlay content; a reveal is audited (source `overlay`); the audit never holds content.

**The other writer to the prefix.** `LocalWorkerRole` (`snapshot-stack.ts`, `grantReadWrite` on the bucket) can write any object, overlay included; it is the role local hosts assume and is
an operator-level credential, outside the owner roles this section is about. Not changed here (Q-O7).

**Audit.** Every overlay edit and discard has a record before any object is written (L44); every owner-reported clear and conflict has an `overlay_apply` record. No owner role reads the audit.

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
| LF-13 | A live write needs a live owner able to serve it; otherwise it waits or goes to the overlay | L2, L5, L33 | A write to an owner that will not poll soon is refused with a retry time; An edit made while the owner is stopping waits for the owner | server |
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
| LF-31 | An open panel does not keep the computer awake and does not start it | L12 | A panel that is open does not keep the computer awake; A panel that is open when the computer is off learns it and starts nothing | server |
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
| LF-47 | A member edits and creates files while the computer is off; the next read shows the edit | L30, L32, 7.7.2, 7.7.3 | An edit made while the computer is off is visible in the next read; A new file made while the computer is off is listed and created only if it does not exist; A computer that never published can still be edited | server |
| LF-48 | An edit with a stale hash is refused; two members cannot both win | L31, L32, R3 | A stale-hash edit made while the computer is off is refused; Two members editing while the computer is off cannot both win; Two members editing different files at the same instant both stand | server |
| LF-49 | Viewing and editing never start a computer | O2, L45 | Editing while the computer is off starts nothing | server |
| LF-50 | An edit made while off is audited with source overlay | L44 | An edit made while the computer is off is audited | server |
| LF-51 | The overlay accepts only what the next publish keeps | L40, L41 | A file in a directory the saved copy never keeps cannot be edited while the computer is off; A link in the saved copy cannot be edited while the computer is off; A file in a folder that does not exist cannot be created while the computer is off; A write into .git is refused while the computer is off; The overlay holds at most 100 edited files | server |
| LF-52 | A secret edited while off is masked on read and revealed with an audit record | L18, L43 | A secret edited while the computer is off is masked on read and revealed with an audit record | server |
| LF-53 | A member can discard a pending edit, audited | 7.7.3 | A member discards their own pending edit | server |
| LF-54 | The seal is the single linearization point between an edit and the owner | L33, R1, R2 | An edit made while the owner extracts the snapshot is in the set the owner seals; An edit made after the owner sealed the overlay waits for the owner; A seal and an edit that race leave exactly one of them in charge | server |
| LF-55 | A stale seal is replaced; an owner of an older generation cannot seal or clear; a clear needs the caller's own seal | L38, 7.7.5 | A seal left by an owner that died is replaced by the next edit; An owner of an older generation cannot seal or clear; A clear that is not sealed by the caller is refused | server |
| LF-56 | Clearing removes exactly the applied entries, and only after a publish is on record | L36, L37 | Clearing removes only the entries that were applied; A clear that names an entry that changed since is ignored; A clear before any publish is recorded is refused | server |
| LF-57 | A change on both sides is a conflict that is shown, kept and never applied silently | L39, R7 | A snapshot that moved under an edit shows a conflict and keeps both versions; An edit made on both sides conflicts and is never applied silently; A conflict can be dropped explicitly; The owner finds a third version on the disk and does not overwrite it | server, supervisor |
| LF-58 | Computers that cannot apply an overlay cannot be edited | L46, L47 | A computer in a customer account cannot be edited while it is off; An owner of protocol 1 blocks edits while it runs | server |
| LF-59 | Only the Front Door writes the overlay; the owner roles cannot write or delete it | 12.8 | The owner roles cannot write or delete overlay objects; The Front Door writes the overlay with conditional puts | server |
| LF-60 | The owner applies the overlay after extraction and before any turn, in every hydrate, and the agent waits for nothing else | L34, L42 | The owner applies the overlay after extraction and before any turn; The owner applies the overlay when the local cache matched; The owner applies the overlay when no snapshot was ever published; A turn that arrives right after the hydrate runs while the entries wait to be cleared | supervisor |
| LF-61 | The owner asks to clear only after the publish that holds the edits; a lost clear is asked again | L36 | The owner asks to clear only after the publish that holds the edits is recorded; A clear that was lost is asked again and before the stopped report; An edit that equals what the snapshot already holds is cleared without a publish | supervisor |
| LF-62 | An overlay the owner cannot apply safely fails the hydrate or becomes a conflict, never a silent skip or an escape | L34, L35 | An overlay that cannot be read fails the hydrate; An overlay blob that does not hash to its entry fails the hydrate; The overlay is applied through the file helper and cannot reach outside the workspace | supervisor |
| LF-63 | The panel edits while the computer is off, marks waiting files, shows overlay conflicts and retries while the computer starts | 10 | A member edits a file while the computer is off; The panel marks a file that is waiting for the computer; A conflict made while the computer was off shows both versions; An edit made while the computer is starting is tried again | web |
| LF-64 | An edit made while off reaches the bot, empties the overlay after the publish, and survives a crash | 7.7.4, 7.7.5 | An edit made while the computer is off is applied on the next hydrate and the bot sees it; The overlay is empty after the publish that holds the edit; The overlay survives a crash of the owner before it publishes | end-to-end |

**Unit tests (vitest), the exception of `AGENTS.md`:** the overlay merge (`overlay-merge`: applied, pending and conflict states, list ordering and cap), the overlay index schema, the swap loop with a fake store that fails the condition, the seal and clear rules as pure functions of (index, computer record, request); `live-file-rules` (`livePathProblem`, `normalizeLivePath`,
`livePathHasGitSegment`, `looksLikeSecretFile`, `looksBinary`, `trimToCharacterBoundary`); the schemas of section 5.2 (including the item
size test of L20 and the unknown-field rules); `ownerFilePanelPace`; the expected-pickup arithmetic of L27; the helper's atomic write with an injected hook between the second
comparison and the rename (the post-check keeps the replaced bytes; the temporary file is removed on every failure; the create is exclusive); the runner's queue
and mutex with a fake launcher and clock; the audit and request codecs; the store contract test (conditional updates, transaction, expired items
ignored, `waiter_gone`); `web/lib/computer-files-edit.ts` and `touched-files.ts`. None of these duplicates a Gherkin scenario: each is a pure
function or a codec.

## 14. Open questions for the owner

The first revision's eleven questions are closed by the owner's answers (section 3.0, O1 to O4). These remain; none is decided for you.

- **Q-O1. The overlay caps.** 100 edited files, 8 MiB in all, 256 KiB each (L41). They bound the apply time and the Lambda memory. Is that enough room for what people will edit while the computer is off?
- **Q-O2. Delete, rename and new folders while off.** Out of Phase 3: they need tombstones and directory entries in the overlay and a rule for the order of the apply. Confirm they wait.
- **Q-O3. Expiring non-current versions in the snapshot bucket.** It is versioned with no expiry (W32), so a cleared overlay blob (an edited `.env`) stays recoverable by an administrator, and so does every old pack and
  manifest. Recommendation: a lifecycle rule that expires non-current versions after 30 days (one CDK line in `snapshot-stack.ts`, part B). It also removes the ability to roll a snapshot back after 30 days. Approve?
- **Q-O4. Customer-account computers.** They read the snapshot and cannot be edited (L46) because nothing there can apply an overlay. Making them editable means teaching the customer host worker to seal, apply and clear
  (the same protocol, a larger change in a different component). Wanted?
- **Q-O5. A few seconds of 503 while an owner starts or stops.** An edit made after the owner sealed the overlay and before it serves (and during a stop) is refused with a retry time; the panel keeps the text and retries by
  itself. The alternative is queueing that edit for the owner, which adds a second queue. Recommendation: accept the short wait.
- **Q-O6. Who may discard a pending edit.** Recommendation: any enabled member, audited, because the workplace is shared. The alternative is only the person who made it or an organization owner.
- **Q-O7. `LocalWorkerRole`.** The snapshot stack's role for local hosts can write any object in the bucket, the overlay included. It is an operator-level credential outside the owner roles. Recommendation: leave it and
  scope it later with the local-host work. Confirm.

## 15. Work assignment

Everything is a pull request into `develop` with the Gherkin first (`AGENTS.md`). Steps for a draft scenario are written by whoever
owns its tag; a scenario enters `features/cucumber-features.txt` together with its steps. This contract, the draft feature and the design
document edits merge first. Do not read or write `project/`. Revision 2 adds infrastructure (part B), the overlay (parts A3 and C2) and splits the server and container work accordingly.

### F0. Foundation (first, small; merged before the others integrate)

Files: `host-protocol/src/live-file-rules.ts`, `live-files.ts` (section 5), **`host-protocol/src/edit-overlay.ts` (section 5.5)**; the exports and constants of
section 5.3 in `host-protocol/src/supervisor.ts` (including `overlay_not_sealed` and the other new error codes) and `host-protocol/package.json` (`./live-files`, `./live-file-rules`, `./edit-overlay`);
`conversation/src/snapshot/files.ts` (import the shared rules); tests `conversation/test/live-file-rules.test.ts`, `live-files-protocol-schema.test.ts`, **`edit-overlay-schema.test.ts`**, and the changes to
`owner-supervisor-protocol-schema.test.ts`. Acceptance: typecheck, `npm test`, `npm run test:features` green with no behavior change except the shared secret name. Does **not** change `OWNER_PROTOCOL_VERSION`.

### B. Infrastructure and policy (independent; deploy before A2 or C2 reach development)

Files: `infra/lib/control-plane-stack.ts` (statement `WriteComputerEditOverlay`, 12.8), `conversation/src/gateway/supervisor-role-policy.json` (the deny statement),
`infra/lib/owner-role-policy.ts` (pass `Effect` through), `conversation/features-support/iam-policy-evaluator.ts` (learn `Deny`), `features/owner_role_policy.feature` and
`computer_owner_policy_coverage.feature` (the overlay rows), `infra/test/computer-owner-stack.test.ts` (assertions: Front Door can write only `overlay/*`, supervisor role has the deny and no delete), and, if approved,
`infra/lib/snapshot-stack.ts` (non-current version expiry, Q-O3). Scenarios: LF-59. Acceptance: `cd infra && npm test`; `cd conversation && npm run test:features`. `cdk deploy` of the ThinTurn stack is by CI on `develop`.

### A1. Server: store, domain, owner routes for file requests (needs F0)

Files: `conversation/src/store/codecs/computer.ts`, `store/codecs/live-file-operation.ts` (new), `store/codecs/file-audit.ts` (new), `store/messaging-store.ts`,
`store/dynamo-messaging-store.ts` (queue transaction, deliver, abandon, complete, count, delete, audit put and finalize, `incrementRateCounter`, `approveOwnerStop`
with the second guard, `touchInteractiveWindow`), `features-support/in-memory-messaging-store.ts` (the same), `domain/computers.ts` (`recordHostSnapshotPublished` and
`recordHostHydrated` as targeted updates, L19, **first commit of the part**), `domain/live-files.ts` (new: `liveFileSourceOf`, expected pickup, `ownerFilePanelPace`,
deliver, record result, finalize audit), `domain/owner-supervisor.ts` (poll delivery, cadence, `stopVeto`, approval token), `http/owner-host-auth.ts`
(`OWNER_COMPUTER_ROUTES`), `http/owner-supervisor.ts` (`ownerFileResultHandler`), `http/app.ts` (declare the route).
Tests: `test/dynamo-messaging-store.contract.test.ts`, `test/owner-supervisor-domain.test.ts`, `test/route-audience.test.ts`, `test/owner-supervisor-client.test.ts` if it lists routes.
Scenarios it makes pass (steps in `features-support/steps/live-files-owner.steps.ts`, a `FakeLiveOwner` in `features-support/fakes/`): the "poll", "result", "fast poll", "idle stop"
and "owner cannot read" scenarios (LF-15 server part, LF-21, LF-28 to LF-31). Acceptance: those scenarios and every existing owner scenario green.

The overlay (seal, clear, unseal in the stopped report) belongs to A3. A1 and A3 both add routes to `OWNER_COMPUTER_ROUTES` and `http/app.ts`; whichever merges second resolves a one-line conflict in `http/owner-host-auth.ts` and `http/app.ts`.

### A3. Server: the overlay core and its owner routes (needs F0; independent of A1)

Files: `conversation/src/snapshot/overlay-store.ts` (new: the port with conditional get, put-if-absent and put-if-match; the S3 implementation with `IfMatch` and `IfNoneMatch`, the filesystem implementation with the same semantics for scenarios; first
task: prove S3 conditional writes against moto 5.2.3 and note the result, L31), `snapshot/overlay-merge.ts` (new: the pure merge of 7.7.2 over `LoadedIndex`), `snapshot/store.ts` (the interface extension),
`domain/edit-overlay.ts` (new: write with the swap loop, discard, seal, clear with the publish-on-record check, conflict marking, stale-seal rule, audit records), `http/owner-host-auth.ts` (`OWNER_COMPUTER_ROUTES`: `overlay-seal`,
`overlay-applied`), `http/owner-supervisor.ts` (two handlers), `http/app.ts` (declare), `http/routes/computer-file-overlay.ts` (new: `POST /overlay/discard`), `domain/computers.ts` and the stopped-report handler in `http/host.ts` (unseal). Tests:
`test/overlay-merge.test.ts`, `test/overlay-store.contract.test.ts`, `test/edit-overlay-domain.test.ts`. Steps: `features-support/steps/edit-overlay.steps.ts` (setup steps write through the domain function so A3 does not need A2). Scenarios: LF-53 to LF-56 and the
store-level halves of LF-57. Acceptance: those green; the overlay contract test passes for both stores.

### A2. Server: member routes (needs A1 and A3)

Files: `conversation/src/http/routes/computer-files.ts` (live or snapshot, `PUT`, reveal, watch), `http/app.ts` (declare), `snapshot/files.ts` (reveal option, provenance
fields, `modified_at`), `domain/file-audit.ts` (new), `lambdas/front-door-composition.ts` (wire the store methods and the clock/sleep), `http/errors` or the route file for the codes of 6.3.
Steps: `features-support/steps/computer-file-live.steps.ts`. Scenarios: LF-1 to LF-14, LF-17 to LF-20, LF-22 to LF-27. Existing scenarios that change: `computer_snapshot_index.feature`
(responses gain `stale`, `fallback_reason`, `modified_at`, `source` stays `snapshot`). Acceptance: those scenarios green; on development, `curl` shows `If-Match` reaches the handler and `ETag` returns.

Revision 2 adds the overlay integration: `http/routes/computer-files.ts` routes the write per 7.3 step 4 (customer, live, `owner_too_old`, stopping, starting, overlay), merges the overlay into every snapshot answer (7.2 step 3, L43), adds `overlay`, `mine_sha256`, `variant`,
`source: "overlay"`; `snapshot/files.ts` accepts the overlay for list, stat, content and reveal and answers an empty `/workspace` plus the overlay when nothing was published. Scenarios: LF-1 to LF-14, LF-17 to LF-20, LF-22 to LF-27, LF-47 to LF-52, LF-54, LF-57 (member side), LF-58.

### C. Container: helper and the supervisor's file runner (needs F0)

Files: `conversation/src/pi/owner-file-helper.ts` (section 8), `conversation/src/pi/unprivileged-execution-env.ts` (Pi `write` through the same operation),
`conversation/src/pi/shell-environment.ts` (new, extracted), `computer/host/src/live-file-operations.ts` (new), `computer/host/src/live-file-helper-launcher.ts` (new),
`computer/host/src/supervisor.ts`, `supervisor-ports.ts`, `supervisor-main.ts`, `protocol-client.ts`, `unprivileged-process-sweeper.ts` only if the mutex needs a hook, `owner-main.ts` (a
`live-file-probe` subcommand beside `file-probe`), `host-protocol/src/supervisor.ts` (`OWNER_PROTOCOL_VERSION = 2`, one line, **in this part**), `computer/test_owner_container.sh`
(run `live-file-probe` for list, read, write and the `.git` refusal as the shell user), `conversation/test/computer-image-structure.test.ts` (the supervisor bundle does not gain `node:fs`
use on request paths, Pi or the starter).
Tests: `test/owner-file-helper.test.ts` (extend), `test/live-file-operations.test.ts`. Steps: `features-support/steps/live-file-supervisor.steps.ts`, a fake launcher and fake plane in
`features-support/fakes/`. Scenarios: LF-12 (helper), LF-16, LF-32 to LF-39. Acceptance: those green; `computer_owner_file_isolation.feature` and `computer_owner_supervisor.feature` green; the
image builds; `test_owner_container.sh` passes (it needs Docker; an owner of the image runs it, Kanbus `chatticus-6c66c5` tracks the local image build).

### C2. Container: the overlay at hydrate (needs F0 and C; the control plane side is faked)

Files: `computer/host/src/overlay-applier.ts` (new, 9.4), `host-disk-lifecycle.ts`, `supervisor.ts` (applied set, early publish check, capture-and-clear, retry), `supervisor-ports.ts`, `protocol-client.ts` (`sealOverlay`, `postOverlayApplied`), `supervisor-main.ts`
(wire the applier and the launcher), `computer/test_owner_container.sh` (an overlay entry applied by a real container), `conversation/test/computer-image-structure.test.ts` (the bundle still imports no Pi). Tests: `test/overlay-applier.test.ts` with a fake launcher, plane and S3.
Steps: `features-support/steps/overlay-supervisor.steps.ts`, fakes in `features-support/fakes/`. Scenarios: LF-57 (supervisor), LF-60 to LF-62. Acceptance: those green; `computer_owner_supervisor.feature` unchanged and green; the image builds.

### W. Web (needs F0 for the shapes; develops against fixtures; integrates after A2)

Files: section 10. New `web/lib/computer-files-edit.ts`; changes to `computer-files.ts`, `computer-files-api.ts`, `touched-files.ts`, `ComputerFilesPanel.tsx`, `ComputerFilesView.tsx`, the
fixtures; vitest beside each; the `@web` steps in the web harness (`features-support/web-harness-runner.ts`, `steps/web-*.steps.ts`), which has no file-panel steps today and must learn a fake running
computer. Scenarios: LF-40 to LF-45. Acceptance: those green, `npm test` in `web/` green, a manual pass at 375 pixels width, and `docs/BRAND_GUIDELINES.md` followed.

Revision 2 adds: edit while the computer is off (`source: "overlay"`), the `Edited, waiting for the computer` mark, the overlay conflict banner, the retry on `computer_starting` and `computer_stopping`, the new error wording, `backed_up` messages (section 10). Scenarios: LF-40 to LF-45 and LF-63.

### E. End to end and live proof (needs A2 and C2)

The `@end-to-end` scenarios (LF-46, LF-64) in one steps file, the live proof (section 17), and the milestone sub-agent for Kanbus and README.

### Order and dependencies

1. This contract (with the feature draft and the design document edits) merges.
2. F0 merges. B is independent and can merge at any time before the server parts deploy.
3. After F0: A1, A3, C and W start in parallel. A2 needs A1 and A3. C2 needs C.
4. E needs A2 and C2 (and so B, A1, A3, C).

### Deploy order (development; no compatibility path)

1. B (the Front Door may write the overlay; the supervisor role is denied) before anything writes an overlay object.
2. A1, A3 and A2: the routes exist; every running owner is protocol 1, so file requests are answered from the snapshot with `owner_too_old`, **edits go to the overlay when the computer is off, and are refused 409 `owner_too_old` while such an owner runs**.
3. C and C2 (one image): the next owner started is protocol 2, seals, applies, serves file requests. An overlay entry written before it exists is applied by it.
4. W when A2 is deployed.
5. The live proof (section 17).

## 16. What changes in existing tests and files

`conversation/test/owner-supervisor-protocol-schema.test.ts` (poll response, veto and error enums, constants), `conversation/test/owner-supervisor-domain.test.ts` (`approveOwnerStop`
signature, poll with file requests), `conversation/test/route-audience.test.ts` (the new routes), `conversation/test/dynamo-messaging-store.contract.test.ts`,
`features/computer_snapshot_index.feature` and `computer-snapshot-files.steps.ts` (new response fields), `features/owner_role_policy.feature` and
`computer_owner_policy_coverage.feature` (the two key families are denied to both roles), `features/computer_owner_file_isolation.feature` (stays green; the Pi `write` is atomic),
`conversation/test/owner-file-helper.test.ts`, `conversation/test/computer-image-structure.test.ts`, `computer/test_owner_container.sh`,
`web/lib/computer-files*.test.ts`, `web/lib/touched-files.test.ts`, `web/lib/computer-files-fixtures.ts`. Revision 2 adds: `features/owner_role_policy.feature` and `computer_owner_policy_coverage.feature` (overlay rows, the deny), `features-support/iam-policy-evaluator.ts` (`Deny`), `infra/test/computer-owner-stack.test.ts`,
`conversation/test/snapshot-files*.test.ts` and `features/computer_snapshot_index.feature` (the overlay merged into snapshot answers, the empty-snapshot case), `computer/host/src/host-disk-lifecycle.ts` tests, `computer/test_owner_container.sh`.
The list is the author's reading of the code; the implementer finds the rest by running the gates.

## 17. Live proof (development)

1. Send a message that makes a bot create two files. While the turn is done and the computer is idle, open the Files panel: the source line reads `Live from the computer`; the new files are listed and
   openable **before** `snapshot_published` appears in the log. The log shows `file_operation` lines with `path_hash` and no paths.
2. Edit a file in the panel and save: `Saved on the computer`; ask the bot to read it back and it answers with the new text; the owner log shows `file_operation kind=write outcome=ok`, then `snapshot_published` about 30 seconds later.
3. Edit the same file from both sides at once (ask the bot to rewrite it while the panel is in edit mode): one edit stands and the panel shows the conflict banner with the bot's version.
4. In the table, find the audit records of step 2 and 3 (`{tenant}#computer#audit`): user id, path, hashes, outcome, no content. Reveal a `.env` file: a `reveal` record exists.
5. Close the panel and watch the poll pace return from 1 second to the idle tier within a minute (`owner_polling` `interval_ms`). Leave the computer for 15 minutes: `owner_stopping reason=idle`, with the last edit in the snapshot.
6. With the computer off, open the panel: `Computer is off. Showing the copy saved ...`, with the editor. Edit a file and save: `Saved. Your change will be applied when the computer starts`. In `aws ecs list-tasks` no task appeared; the computer record is unchanged; `overlay/index.json` and one blob exist under the computer's prefix; the audit has a record with source `overlay`.
6a. Ask the bot to read that file. The log shows `owner_started`, `workspace_hydrated`, `overlay_sealed`, `overlay_applied` before `owner_dispatch_received`; the bot answers with the edited text. About 5 seconds after the supervisor is idle, `snapshot_published` and `overlay_cleared remaining=0`; `overlay/index.json` is empty and unsealed after the stop.
6b. Edit a second file while the computer is off, start it, and `aws ecs stop-task` it right after `overlay_applied` and before `snapshot_published`: the panel still shows the edit (snapshot plus overlay), and the next owner applies it.
6c. Make the snapshot move under an edit (publish a different content for the same file from another path, for example by a bot turn on a copy) and see the conflict banner; resolve it with `Use theirs`.
7. Check on the CloudFront path: `If-Match` arrives, `ETag` returns, the `PUT` body of 256 KiB passes.
8. Prove S3 conditional writes on the real bucket (the `If-Match` and `If-None-Match` of the overlay index) and that the supervisor credentials are denied a `PutObject` to `overlay/` (`aws s3api put-object` with them). Measure on a running 512 MiB owner: memory with two helpers reading 8 MiB files during a quiet publish (risk R1).

## 18. Assumptions and risks

**Assumptions** (marked where they appear): CloudFront forwards `If-Match` and returns `ETag` unchanged on `/api*` (6.2); a Node helper costs 40 to 60 MiB (12.5);
SHA-256 of 8 MiB on 0.25 vCPU takes well under a second; the 342 KB worst-case item and result body fit the Lambda and table limits (L20); `fsync` on the task's ephemeral disk is
cheap; the membership cache bound of 30 seconds; DynamoDB `TransactWriteItems` on the computer record and a request item is available with the same client the store already uses
(`dynamo-messaging-store.ts` imports `TransactWriteItemsCommand`).

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Memory at 512 MiB**: supervisor, one Pi turn, two helpers and a publish in one container | concurrency 2, `owner_busy` at 90 percent, 8 MiB cap, helper timeout; measured in the live proof before C14 is touched; the next lever is concurrency 1 |
| R2 | **Poll cost** of the interactive pace with a forgotten tab | 45 second window, no panel keep-alive of the computer, 15 minute idle stop |
| R3 | **A lost edit** if the owner dies before the next publish | the dirty flag settles the record; the UI says `not yet in the saved copy`; the quiet publish runs 30 seconds after a write at the next gap (accepted, O4) |
| R4 | **The record race** (L19) was an existing hazard for dispatch fields | fixed first in A1; contract test |
| R5 | **Protocol skew** between a new server and an old owner | the version gate; fallback `owner_too_old`; at most 50 minutes |
| R6 | **Temporary file litter** after a killed helper | recognisable name, listed, harmless; revisit with a sweeper if seen |
| R7 | **Pi `write` changes to atomic** and loses hard links | stated; the isolation scenarios cover links; no hard links are expected in a workspace |
| R8 | **Web harness has no file-panel steps** | W owns extending it; the pure logic stays in vitest so the risk is the harness work, not the logic |
| R9 | **Two sources of truth for masking** (helper and Front Door) | one predicate in `live-file-rules.ts`; the Front Door applies it again (L25) |
| R10 | **S3 conditional writes** are the foundation of the overlay (L31) and moto 5.2.3 may not honor both | A3 proves it first; the filesystem store has the same semantics for scenarios; the real bucket is checked in the live proof; the fallback is a DynamoDB index with the blobs still in S3 |
| R11 | **A false conflict** after two lost clears in a row | the retry every 10 seconds and before the stopped report; the conflict is surfaced with both versions, never overwritten |
| R12 | **Deleted secrets recoverable** from non-current versions | Q-O3 |
| R13 | **The apply fails the hydrate** for a bad overlay, so the computer does not start | the budget is 30 seconds; a conflict is not a failure; only unreadable or tampered blobs fail it; the Front Door is the only writer and validates every blob it writes |
| R14 | **A 503 window** while an owner seals or stops | 2 to 5 seconds, automatic retry in the panel, text kept (Q-O5) |
| R15 | **Overlay edits are in the saved copy only as the next read sees it** until a publish folds them in; a crash before the publish leaves them in the overlay | by design (L36); that is why the overlay survives a crash |

## 19. Cost

Prices (US East; ASSUMPTION: not re-verified in this session): S3 `PUT` 0.005 USD per 1000, `GET` 0.0004 USD per 1000, storage 0.023 USD per GB-month, DynamoDB on-demand write 0.625 USD per million
write units, Lambda ARM 0.0000133 USD per GB-second.

| Item | Cost |
| --- | --- |
| An edit made while the computer is off | one `GET` of the index, one `PUT` of the blob, one `PUT` of the index, two audit writes, about 100 ms of a 512 MB Lambda: **about 0.000013 USD**. A thousand edits: about 1.3 cents |
| A read while the computer is off | the existing reads plus one conditional `GET` of the overlay index: **0.0000004 USD** |
| Storage | at most 8 MiB per computer: 0.0002 USD a month at the cap, plus non-current versions until Q-O3 is decided |
| An owner start | the seal (one `GET`, one `PUT`), up to 100 blob `GET`s, the clear (one `GET`, one `PUT`, deletes are free), audit writes: **about 0.00001 USD typical, 0.0001 worst case** |
| A computer to apply it | none beyond the start the person's next message causes anyway. **Editing while off costs S3 requests only (O1)**; no Fargate time is spent for an edit and no task is started |
| The watch ping when off | two table reads per 15 seconds while the tab is visible: about 0.0000003 USD each |
| The live path | as section 12.5 and the cost table of the design: the 1 second pace costs about 0.7 cents an hour **only while a running computer has a panel open** (O3) |
