# DRAFT. Not in features/cucumber-features.txt and not run by any gate: no step definitions exist yet.
# The contract is docs/LIVE_FILES_PROTOCOL.md; the traceability table in its section 13 maps every
# requirement to a scenario name below. Whoever builds a part writes the steps for the tag they own
# (@server, @supervisor, @web, @end-to-end) and adds this file to the list together with those steps.
# Scenario names are the contract: do not rename one without changing the table.
# Moved to computer_file_live_owner.feature (run, with steps): the poll delivery, result route, fast poll, idle stop veto and
# role policy scenarios of LF-15, LF-21, LF-28 to LF-31. The four scenarios that need the member routes (the stop race as a
# member response, a result for an abandoned read, a result recorded once for a member read, and the hash disagreement as a
# member write) stay here for part A2; their owner side is covered there under the names in that file.
# The scenarios of LF-53 to LF-56 and the store-level halves of LF-57 (discard, seal, stale seal, clear, derived
# conflicts) moved to features/computer_file_overlay.feature, which is registered and runs. The container scenarios of LF-57, LF-60 to
# LF-62 and LF-73 (the overlay at hydrate) moved to features/computer_file_overlay_supervisor.feature, registered and run.

Feature: Members view and edit the files on the running computer
  As a member of an organization
  I want to see the files on the computer as they are right now and to change one
  So that I can read what my bots made before it is saved, and fix a file without sending a chat message

  While the computer is off, the Front Door answers file requests from the last saved snapshot, as it does today. While a
  long-lived owner is running, the same routes are answered by the owner: the Front Door leaves a file request in the table,
  the owner receives it in its next poll, runs it through the unprivileged file helper and posts the result. A member edits
  with an optimistic hash check; every edit and every reveal of a masked file is written to an audit record by the Front
  Door, in a key family that neither owner role can reach. An open Files panel tells the control plane to be quick for a
  short while. The wire schemas are in host-protocol/src/live-files.ts.

  The computer is needed only to run things. While it is off a member reads and edits files all the same: an edit is
  kept in an overlay in the snapshot bucket (one small object per edited file and an index, written only by the Front
  Door with conditional puts), reads merge the overlay over the snapshot, and the next owner seals the overlay after it
  extracts the snapshot, applies it through the file helper before any turn runs, and has it cleared once a publish
  that holds the edits is recorded. Viewing and editing never start a computer; an open panel does not keep one awake.
  The schemas of the overlay are in host-protocol/src/edit-overlay.ts.

  Deleting, renaming and creating folders work the same way, also while the computer is off: the overlay records a
  tombstone, a move that keeps the content hash (no copy of the file), or an empty directory, each judged against the
  effective hash. At hydrate the owner applies new folders, then renames, then edits, then deletes. Any member may delete
  a file or an empty folder and rename; only the organization owner role deletes a folder that is not empty.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has computer "household-computer"
    And tenant "anthus" has member "mia"
    And a snapshot bucket for the computer file routes
    And a fake owner credential broker

  # ---------------------------------------------------------------- reading

  @server
  Scenario: A live read reflects a change that was never published
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "second draft"
    When a member reads the computer file "/workspace/notes.md"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    And the file response says "source" is "live"
    And the file response says "stale" is "false"
    And the content response holds "second draft"
    And the content response has the SHA-256 of "second draft" and the same ETag

  @server
  Scenario: A live listing shows a file the saved copy does not have
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "b.txt" containing "b"
    When a member lists the computer files at "/workspace"
    And the owner polls and answers the file request it is given
    Then the file response says "source" is "live"
    And the listing shows these entries in order:
      | name  | kind |
      | a.txt | file |
      | b.txt | file |

  @server
  Scenario: A computer that is off is answered from the saved copy and is not stale
    Given the computer disk holds workspace file "notes.md" containing "saved"
    And the computer disk is published
    And no owner is running
    When a member reads the computer file "/workspace/notes.md"
    Then the file response status is 200
    And the file response says "source" is "snapshot"
    And the file response says "stale" is "false"
    And the file response was published as of the manifest time

  @server
  Scenario: An owner that is still hydrating is answered from the saved copy and marked stale
    Given the computer disk holds workspace file "notes.md" containing "saved"
    And the computer disk is published
    And a live owner is polling for the household computer in state "hydrating"
    When a member reads the computer file "/workspace/notes.md"
    Then the file response says "source" is "snapshot"
    And the file response says "stale" is "true"
    And the file response says "fallback_reason" is "owner_not_ready"
    And no file request was left for the owner

  @server
  Scenario: An owner that predates file operations is answered from the saved copy
    Given the computer disk holds workspace file "notes.md" containing "saved"
    And the computer disk is published
    And a live owner is polling for the household computer with protocol version 1
    When a member reads the computer file "/workspace/notes.md"
    Then the file response says "source" is "snapshot"
    And the file response says "fallback_reason" is "owner_too_old"

  @server
  Scenario: A live request that times out falls back to the saved copy and says stale
    Given the computer disk holds workspace file "notes.md" containing "saved"
    And the computer disk is published
    And a live owner is polling for the household computer every 1 second
    When a member reads the computer file "/workspace/notes.md" and the owner does not answer for 8 seconds
    Then the file response status is 200
    And the file response says "source" is "snapshot"
    And the file response says "stale" is "true"
    And the file response says "fallback_reason" is "owner_timeout"
    And the file request was abandoned and its payload removed

  @server
  Scenario: An owner that is slow to poll is not waited for
    Given the computer disk holds workspace file "notes.md" containing "saved"
    And the computer disk is published
    And a live owner that polls every 10 seconds and last polled 1 second ago
    When a member reads the computer file "/workspace/notes.md"
    Then the file response is answered at once from the saved copy
    And the file response says "fallback_reason" is "owner_warming"
    And the file response says "retry_after_ms" is "9000"
    And no file request was left for the owner
    And the owner is told to poll every 1 second

  @server
  Scenario: A file deleted on the computer is not found even though the saved copy has it
    Given the computer disk holds workspace file "gone.md" containing "old"
    And the computer disk is published
    And a live owner is polling for the household computer
    When a member reads the computer file "/workspace/gone.md"
    And the owner polls and answers the file request it is given
    Then the file response status is 404
    And the file response error is "not_found"

  @server
  Scenario: A binary file is returned in pieces and every piece names the hash of the whole file
    Given a live owner is polling for the household computer
    And the live disk of the owner holds a binary file "/workspace/logo.png" of 300000 bytes
    When a member reads 262144 bytes of the computer file "/workspace/logo.png" from offset 0
    And the owner polls and answers the file request it is given
    Then the file response says "encoding" is "base64"
    And the file response says "truncated" is "true"
    When a member reads 262144 bytes of the computer file "/workspace/logo.png" from offset 262144
    And the owner polls and answers the file request it is given
    Then both pieces name the same SHA-256

  @server
  Scenario: A file over the read limit is refused with its size
    Given a live owner is polling for the household computer
    And the live disk of the owner holds a file "/workspace/big.bin" of 9000000 bytes
    When a member reads the computer file "/workspace/big.bin"
    And the owner polls and answers the file request it is given
    Then the file response status is 413
    And the file response error is "file_too_large"
    And a member lists the computer files at "/workspace" and the listing shows "big.bin" as a file of 9000000 bytes

  @server
  Scenario: A listing is cut at 2000 entries
    Given a live owner is polling for the household computer
    And the live disk of the owner holds 2500 files in "/workspace/many"
    When a member lists the computer files at "/workspace/many"
    And the owner polls and answers the file request it is given
    Then the listing has 2000 entries
    And the file response says "truncated" is "true"

  # ---------------------------------------------------------------- writing

  @server
  Scenario: A member edits a file and the owner has it
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    And the file response says "created" is "false"
    And the file response says "sha256" is the hash of "second draft"
    And the file response says "previous_sha256" is the hash of "first draft"
    And the live disk of the owner holds workspace file "notes.md" containing "second draft"
    And the computer record says the disk is dirty

  @server
  Scenario: A write with a stale hash is refused and nothing changes
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "mine" if it still has the hash of "an older draft"
    And the owner polls and answers the file request it is given
    Then the file response status is 409
    And the file response error is "precondition_failed"
    And the file response says "current_sha256" is the hash of "first draft"
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"

  @server
  Scenario: A write without a precondition is refused before it reaches the owner
    Given a live owner is polling for the household computer
    When member "mia" replaces the computer file "/workspace/notes.md" with "mine" and sends no precondition
    Then the file response status is 428
    And the file response error is "precondition_required"
    And no file request was left for the owner

  @server
  Scenario: A new file is created only if it does not exist
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "taken.md" containing "old"
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    And the file response says "created" is "true"
    When member "mia" creates the computer file "/workspace/taken.md" with "new"
    And the owner polls and answers the file request it is given
    Then the file response status is 409
    And the file response error is "already_exists"
    And the live disk of the owner holds workspace file "taken.md" containing "old"

  @server
  Scenario: A concurrent edit by the bot is reported as a conflict with the bot's version
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "plan.md" containing "v1"
    And member "mia" has read the computer file "/workspace/plan.md" and holds its hash
    And the bot writes "v2 from Pi" to the live file "/workspace/plan.md"
    When member "mia" replaces the computer file "/workspace/plan.md" with "v2 from Mia" if it still has the hash of "v1"
    And the owner polls and answers the file request it is given
    Then the file response status is 409
    And the file response says "current_sha256" is the hash of "v2 from Pi"
    And the live disk of the owner holds workspace file "plan.md" containing "v2 from Pi"
    When member "mia" replaces the computer file "/workspace/plan.md" with "v2 from Mia" if it still has the hash of "v2 from Pi"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    And the live disk of the owner holds workspace file "plan.md" containing "v2 from Mia"

  @server
  Scenario: A write larger than 256 KiB is refused before it reaches the owner
    Given a live owner is polling for the household computer
    When member "mia" replaces the computer file "/workspace/notes.md" with 262145 bytes if it still has the hash of "first draft"
    Then the file response status is 413
    And the file response error is "content_too_large"
    And no file request was left for the owner

  @server
  Scenario: A file larger than the edit limit cannot be replaced
    Given a live owner is polling for the household computer
    And the live disk of the owner holds a file "/workspace/big.txt" of 300000 bytes
    When member "mia" replaces the computer file "/workspace/big.txt" with "short" if it still has the hash of that file
    And the owner polls and answers the file request it is given
    Then the file response status is 413
    And the file response error is "file_too_large"
    And the live file "/workspace/big.txt" still has 300000 bytes

  @server
  Scenario Outline: A write into a .git directory is refused
    Given a live owner is polling for the household computer
    When member "mia" creates the computer file "<path>" with "[core]"
    Then the file response status is 403
    And the file response error is "path_refused"
    And no file request was left for the owner
    And the audit log has a record for member "mia" with outcome "refused" and error "path_refused"

    Examples:
      | path                              |
      | /workspace/.git/config            |
      | /workspace/app/.git/hooks/pre-commit |
      | /workspace/.git                   |

  @server
  Scenario: A write to an owner that will not poll soon is refused with a retry time
    Given a live owner that polls every 10 seconds and last polled 1 second ago
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    Then the file response status is 503
    And the file response error is "owner_warming"
    And the file response says "retry_after_ms" is "9000"
    And no file request was left for the owner
    And the audit log has no records

  @server
  Scenario: A write the owner never took does not happen later
    Given a live owner is polling for the household computer every 10 seconds
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft" and the owner does not answer for 8 seconds
    Then the file response status is 504
    And the file response error is "owner_timeout"
    When the owner polls
    Then the poll response carries no file request
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"

  @server
  Scenario: A write the owner took but did not answer is reported as unknown and audited when the answer comes
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the owner polls and holds the file request for 16 seconds
    Then the file response status is 504
    And the file response error is "outcome_unknown"
    When the owner posts the result of the write it held
    Then the audit log has a record for member "mia" with outcome "ok"

  @server
  Scenario: An edit made while the owner is stopping waits for the owner
    Given a live owner is polling for the household computer
    And the owner's stop request was approved
    And the overlay is sealed by that owner
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    Then the file response status is 503
    And the file response error is "computer_stopping"
    And the file response says "retry_after_ms" is "5000"
    And the audit log has no records

  @server
  Scenario: A stop and a file operation cannot both win
    Given a live owner is polling for the household computer
    When the owner's idle stop is approved between a member's request being judged and being queued
    Then the member's file request is not queued
    And the file response says "fallback_reason" is "owner_stopping"

  # ---------------------------------------------------------------- editing while the computer is off (the edit overlay)

  @server
  Scenario: An edit made while the computer is off is visible in the next read
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    Then the file response status is 200
    And the file response says "source" is "overlay"
    And the file response says "backed_up" is "true"
    And the file response says "previous_sha256" is the hash of "first draft"
    When a member reads the computer file "/workspace/notes.md"
    Then the file response says "source" is "snapshot"
    And the content response holds "second draft"
    And the content response has the SHA-256 of "second draft" and the same ETag
    And the file response says "overlay" is "pending"
    And the saved snapshot pack was not changed

  @server
  Scenario: A new file made while the computer is off is listed and created only if it does not exist
    Given the computer disk holds workspace file "taken.md" containing "old"
    And the computer disk is published
    And no owner is running
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    Then the file response status is 200
    And the file response says "created" is "true"
    When a member lists the computer files at "/workspace"
    Then the listing shows these entries in order:
      | name     | kind |
      | fresh.md | file |
      | taken.md | file |
    When member "mia" creates the computer file "/workspace/taken.md" with "new"
    Then the file response status is 409
    And the file response error is "already_exists"

  @server
  Scenario: A computer that never published can still be edited
    Given no owner is running
    And the computer has never published a snapshot
    When member "mia" creates the computer file "/workspace/first.md" with "hello"
    Then the file response status is 200
    When a member reads the computer file "/workspace/first.md"
    Then the content response holds "hello"

  @server
  Scenario: A stale-hash edit made while the computer is off is refused
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    When member "mia" replaces the computer file "/workspace/notes.md" with "mine" if it still has the hash of "an older draft"
    Then the file response status is 409
    And the file response error is "precondition_failed"
    And the file response says "current_sha256" is the hash of "first draft"
    And the overlay holds no entry for "/workspace/notes.md"

  @server
  Scenario: Two members editing while the computer is off cannot both win
    Given the computer disk holds workspace file "plan.md" containing "v1"
    And the computer disk is published
    And no owner is running
    And member "mia" has read the computer file "/workspace/plan.md" and holds its hash
    And member "ryan" has read the computer file "/workspace/plan.md" and holds its hash
    When member "mia" replaces the computer file "/workspace/plan.md" with "from Mia" if it still has the hash of "v1"
    And member "ryan" replaces the computer file "/workspace/plan.md" with "from Ryan" if it still has the hash of "v1"
    Then the first file response status is 200
    And the second file response status is 409
    And the second file response says "current_sha256" is the hash of "from Mia"
    And the overlay holds "from Mia" for "/workspace/plan.md"

  @server
  Scenario: Two members editing different files at the same instant both stand
    Given the computer disk holds workspace file "a.md" containing "a"
    And the computer disk holds workspace file "b.md" containing "b"
    And the computer disk is published
    And no owner is running
    When member "mia" and member "ryan" replace "/workspace/a.md" and "/workspace/b.md" at the same instant
    Then both file responses have status 200
    And the overlay holds both entries

  @server
  Scenario: Editing while the computer is off starts nothing
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    Then no computer start job is queued
    And the computer record is unchanged

  @server
  Scenario: An edit made while the computer is off is audited
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    Then the audit log has one record for member "mia" with these fields:
      | field         | value                      |
      | operation     | write                      |
      | path          | /workspace/notes.md        |
      | outcome       | ok                         |
      | source        | overlay                    |
      | sha256_before | the hash of "first draft"  |
      | sha256_after  | the hash of "second draft" |
    And the audit record holds no file content

  @server
  Scenario: A file in a directory the saved copy never keeps cannot be edited while the computer is off
    Given the computer disk holds workspace file "app/package.json" containing "{}"
    And the computer disk is published
    And no owner is running
    When member "mia" creates the computer file "/workspace/app/node_modules/x/index.js" with "x"
    Then the file response status is 422
    And the file response error is "not_in_saved_copy"
    And the overlay holds no entry for "/workspace/app/node_modules/x/index.js"

  @server
  Scenario: A link in the saved copy cannot be edited while the computer is off
    Given the computer disk holds workspace file "real.txt" containing "one"
    And the computer disk holds a symbolic link "alias.txt" to "real.txt"
    And the computer disk is published
    And no owner is running
    When member "mia" replaces the computer file "/workspace/alias.txt" with "two" if it still has the hash of "one"
    Then the file response status is 403
    And the file response error is "path_refused"

  @server
  Scenario: A file in a folder that does not exist cannot be created while the computer is off
    Given the computer disk holds workspace file "notes.md" containing "x"
    And the computer disk is published
    And no owner is running
    When member "mia" creates the computer file "/workspace/missing/new.md" with "x"
    Then the file response status is 404
    And the file response error is "parent_missing"

  @server
  Scenario: A write into .git is refused while the computer is off
    Given the computer disk holds workspace file "notes.md" containing "x"
    And the computer disk is published
    And no owner is running
    When member "mia" creates the computer file "/workspace/.git/config" with "[core]"
    Then the file response status is 403
    And the file response error is "path_refused"
    And the overlay holds no entry for "/workspace/.git/config"

  @server
  Scenario: The overlay holds at most 100 edited files
    Given the computer disk is published
    And no owner is running
    And member "mia" has created 100 files while the computer is off
    When member "mia" creates the computer file "/workspace/one-too-many.md" with "x"
    Then the file response status is 409
    And the file response error is "overlay_full"

  @server
  Scenario: A secret edited while the computer is off is masked on read and revealed with an audit record
    Given the computer disk holds workspace file ".env" containing "API_KEY=abc123"
    And the computer disk is published
    And no owner is running
    When member "mia" replaces the computer file "/workspace/.env" with "API_KEY=def456" if it still has the hash of "API_KEY=abc123"
    Then the file response status is 200
    When a member reads the computer file "/workspace/.env"
    Then the file response says "masked" is "true"
    And the file response carries no file content
    When member "mia" reveals the computer file "/workspace/.env"
    Then the content response holds "API_KEY=def456"
    And the audit log has one record for member "mia" with these fields:
      | field     | value  |
      | operation | reveal |
      | source    | overlay |

  @server
  Scenario: A computer in a customer account cannot be edited while it is off
    Given the organization is homed in a customer account
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    Then the file response status is 409
    And the file response error is "edit_unsupported"

  @server
  Scenario: An owner of protocol 1 blocks edits while it runs
    Given the computer disk holds workspace file "notes.md" containing "x"
    And the computer disk is published
    And a live owner is polling for the household computer with protocol version 1
    When member "mia" replaces the computer file "/workspace/notes.md" with "y" if it still has the hash of "x"
    Then the file response status is 409
    And the file response error is "owner_too_old"

  @server
  Scenario: The owner roles cannot write or delete overlay objects
    Then the per-turn role policy denies s3:GetObject, s3:PutObject and s3:DeleteObject on "tenants/anthus/computers/household-computer/overlay/index.json"
    And the per-turn role policy denies s3:PutObject and s3:DeleteObject on "tenants/anthus/computers/household-computer/overlay/blobs/abc"
    And the supervisor role policy allows s3:GetObject on "tenants/anthus/computers/household-computer/overlay/index.json"
    And the supervisor role policy denies s3:PutObject, s3:DeleteObject and s3:DeleteObjectVersion on "tenants/anthus/computers/household-computer/overlay/index.json"
    And the supervisor role policy denies s3:PutObject on "tenants/anthus/computers/household-computer/overlay/blobs/abc"
    And the supervisor role policy still allows s3:PutObject on "tenants/anthus/computers/household-computer/snapshot.tar.gz"
    And the supervisor role policy denies every action on the overlay of another computer

  @server
  Scenario: The Front Door writes the overlay with conditional puts
    Given the computer disk is published
    And no owner is running
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    Then the overlay blob was put with "If-None-Match: *"
    And the overlay index was put with a condition on the entity tag it had read

  # ---------------------------------------------------------------- delete, rename and new folders

  @server
  Scenario: A file deleted while the computer is off is gone from the next read and from the listing
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk holds workspace file "b.txt" containing "b"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "a"
    Then the file response status is 200
    And the file response says "source" is "overlay"
    And the file response says "backed_up" is "true"
    When a member reads the computer file "/workspace/a.txt"
    Then the file response status is 404
    And the file response error is "not_found"
    When a member lists the computer files at "/workspace"
    Then the listing shows these entries in order:
      | name  | kind |
      | b.txt | file |
    And the saved snapshot pack was not changed
    And no computer start job is queued

  @server
  Scenario: A file renamed while the computer is off keeps its content and is read from the saved pack
    Given the computer disk holds workspace file "old.txt" containing "same bytes"
    And the computer disk is published
    And no owner is running
    When member "mia" renames the computer file "/workspace/old.txt" to "/workspace/new.txt" if it still has the hash of "same bytes"
    Then the file response status is 200
    And the overlay holds a move from "/workspace/old.txt" to "/workspace/new.txt" with the hash of "same bytes" and no blob
    When a member reads the computer file "/workspace/new.txt"
    Then the content response holds "same bytes"
    And the content response has the SHA-256 of "same bytes" and the same ETag
    When a member reads the computer file "/workspace/old.txt"
    Then the file response status is 404
    And the file response says nothing about a copy of the file in the overlay

  @server
  Scenario: A folder created while the computer is off is listed and creating it again is harmless
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" creates the computer folder "/workspace/docs"
    Then the file response status is 200
    And the file response says "created" is "true"
    When a member lists the computer files at "/workspace"
    Then the listing shows these entries in order:
      | name  | kind      |
      | docs  | directory |
      | a.txt | file      |
    When member "mia" creates the computer folder "/workspace/docs"
    Then the file response status is 200
    And the file response says "created" is "false"
    And the overlay holds one entry
    And the audit log has one record with operation "mkdir"

  @server
  Scenario: A delete with a stale hash is refused
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "an older a"
    Then the file response status is 409
    And the file response error is "precondition_failed"
    And the file response says "current_sha256" is the hash of "a"
    And the overlay holds no entry for "/workspace/a.txt"

  @server
  Scenario: A rename without a precondition is refused
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" renames the computer file "/workspace/a.txt" to "/workspace/b.txt" and sends no precondition
    Then the file response status is 428
    And the file response error is "precondition_required"

  @server
  Scenario: A rename onto an existing path is refused
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk holds workspace file "b.txt" containing "b"
    And the computer disk is published
    And no owner is running
    When member "mia" renames the computer file "/workspace/a.txt" to "/workspace/b.txt" if it still has the hash of "a"
    Then the file response status is 409
    And the file response error is "already_exists"
    And the overlay holds no entry

  @server
  Scenario: A folder cannot be renamed into its own subtree
    Given the computer disk holds workspace file "src/a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" renames the computer folder "/workspace/src" to "/workspace/src/inner" if it still has the tree hash it was shown
    Then the file response status is 422
    And the file response error is "invalid_move"

  @server
  Scenario Outline: The workspace root cannot be deleted or renamed
    Given the computer disk is published
    And no owner is running
    When member "ryan" <action> the computer folder "/workspace"
    Then the file response status is 403
    And the file response error is "path_refused"

    Examples:
      | action        |
      | deletes       |
      | renames       |

  @server
  Scenario: A member deletes a file and an empty folder
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk holds an empty folder "empty"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "a"
    And member "mia" deletes the computer folder "/workspace/empty" if it still has the tree hash it was shown
    Then both file responses have status 200
    And the audit log has two records for member "mia" with operation "delete"

  @server
  Scenario: Only the owner role deletes a folder that is not empty
    Given the computer disk holds workspace file "old/a.txt" containing "a"
    And the computer disk holds workspace file "old/b.txt" containing "b"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer folder "/workspace/old" recursively if it still has the tree hash it was shown
    Then the file response status is 403
    And the file response error is "owner_role_required"
    When member "mia" deletes the computer folder "/workspace/old" without recursion
    Then the file response status is 409
    And the file response error is "directory_not_empty"
    When the organization owner "ryan" deletes the computer folder "/workspace/old" recursively if it still has the tree hash it was shown
    Then the file response status is 200
    And the overlay holds one delete of the folder "/workspace/old" with its tree hash
    When a member lists the computer files at "/workspace"
    Then the listing is empty

  @server
  Scenario: A member renames a folder that is not empty
    Given the computer disk holds workspace file "old/a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" renames the computer folder "/workspace/old" to "/workspace/new" if it still has the tree hash it was shown
    Then the file response status is 200
    When a member reads the computer file "/workspace/new/a.txt"
    Then the content response holds "a"
    When a member lists the computer files at "/workspace/old"
    Then the file response status is 404

  @server
  Scenario: A change under a folder that is waiting to be renamed is refused until it is applied
    Given the computer disk holds workspace file "old/a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    And member "mia" renamed the folder "/workspace/old" to "/workspace/new" while the computer was off
    When member "ryan" replaces the computer file "/workspace/new/a.txt" with "b" if it still has the hash of "a"
    Then the file response status is 409
    And the file response error is "path_busy"
    When member "ryan" creates the computer file "/workspace/old/c.txt" with "c"
    Then the file response status is 409
    And the file response error is "path_busy"

  @server
  Scenario: Deleting a file that was created while the computer was off leaves nothing to apply
    Given the computer disk is published
    And no owner is running
    And member "mia" created "/workspace/draft.md" with "draft" while the computer was off
    When member "mia" deletes the computer file "/workspace/draft.md" if it still has the hash of "draft"
    Then the file response status is 200
    And the overlay holds no entry

  @server
  Scenario: Renaming a file back to its own path leaves nothing to apply
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    And member "mia" renamed "/workspace/a.txt" to "/workspace/b.txt" while the computer was off
    When member "mia" renames the computer file "/workspace/b.txt" to "/workspace/a.txt" if it still has the hash of "a"
    Then the file response status is 200
    And the overlay holds no entry

  @server
  Scenario: Pending changes of every kind are listed and any member can discard one
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk holds workspace file "b.txt" containing "b"
    And the computer disk is published
    And no owner is running
    And member "mia" deleted "/workspace/a.txt" and renamed "/workspace/b.txt" to "/workspace/c.txt" and created the folder "/workspace/docs" while the computer was off
    When a member lists the pending changes
    Then the pending changes are a delete of "/workspace/a.txt", a move from "/workspace/b.txt" to "/workspace/c.txt" and a mkdir of "/workspace/docs"
    When member "ryan" discards the pending change of "/workspace/a.txt"
    Then the file response status is 200
    And a member reads the computer file "/workspace/a.txt" and gets "a"
    And the audit log has a record for member "ryan" with operation "discard"

  @server
  Scenario Outline: A delete, rename or new folder under .git is refused
    Given the computer disk holds workspace file "notes.md" containing "x"
    And the computer disk is published
    And no owner is running
    When member "mia" <action> "/workspace/.git/hooks"
    Then the file response status is 403
    And the file response error is "path_refused"
    And the overlay holds no entry

    Examples:
      | action                  |
      | creates the folder      |
      | deletes the path        |
      | renames the path from   |
      | renames the path to     |

  @server
  Scenario: A link in the saved copy is deleted as a link and its target is untouched
    Given the computer disk holds workspace file "real.txt" containing "one"
    And the computer disk holds a symbolic link "alias.txt" to "real.txt"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer file "/workspace/alias.txt" if it still has the symlink hash it was shown
    Then the file response status is 200
    When a member reads the computer file "/workspace/real.txt"
    Then the content response holds "one"
    When a member reads the computer file "/workspace/alias.txt"
    Then the file response status is 404

  @server
  Scenario: A delete or rename under a folder the saved copy never keeps is refused while the computer is off
    Given the computer disk holds workspace file "app/package.json" containing "{}"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer folder "/workspace/app/node_modules" without recursion
    Then the file response status is 422
    And the file response error is "not_in_saved_copy"

  @server
  Scenario: The overlay counts every kind of change toward its 100
    Given the computer disk is published
    And no owner is running
    And member "mia" has created 99 folders and 1 file while the computer is off
    When member "mia" creates the computer folder "/workspace/one-too-many"
    Then the file response status is 409
    And the file response error is "overlay_full"

  @server
  Scenario: A running computer deletes, renames and creates folders through the owner
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "a.txt" containing "a"
    And the live disk of the owner holds workspace file "b.txt" containing "b"
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "a"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    And the file response says "source" is "live"
    And the file response says "backed_up" is "false"
    When member "mia" renames the computer file "/workspace/b.txt" to "/workspace/c.txt" if it still has the hash of "b"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    When member "mia" creates the computer folder "/workspace/docs"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    And the live disk of the owner has "c.txt" and "docs" and not "a.txt" or "b.txt"
    And the computer record says the disk is dirty
    And the overlay holds no entry

  @server
  Scenario: A delete, a rename and a new folder are audited
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk holds workspace file "b.txt" containing "b"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "a"
    And member "mia" renames the computer file "/workspace/b.txt" to "/workspace/c.txt" if it still has the hash of "b"
    And member "mia" creates the computer folder "/workspace/docs"
    Then the audit log has these records for member "mia":
      | operation | path                | to_path             | outcome | source  | sha256_before        |
      | delete    | /workspace/a.txt    |                     | ok      | overlay | the hash of "a"      |
      | move      | /workspace/b.txt    | /workspace/c.txt    | ok      | overlay | the hash of "b"      |
      | mkdir     | /workspace/docs     |                     | ok      | overlay |                      |
    And the audit records hold no file content

  # ---------------------------------------------------------------- audit

  @server
  Scenario: An edit lands in the audit log
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the owner polls and answers the file request it is given
    Then the audit log has one record for member "mia" with these fields:
      | field            | value                       |
      | operation        | write                       |
      | path             | /workspace/notes.md         |
      | outcome          | ok                          |
      | source           | live                        |
      | sha256_before    | the hash of "first draft"   |
      | sha256_after     | the hash of "second draft"  |
      | bytes            | 12                          |
      | revealed         | false                       |
    And the audit record holds no file content
    And the audit record expires in 90 days

  @server
  Scenario: A refused write is audited as refused
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "mine" if it still has the hash of "an older draft"
    And the owner polls and answers the file request it is given
    Then the audit log has a record for member "mia" with outcome "conflict"

  @server
  Scenario: The audit record is written before the owner is asked
    Given a live owner is polling for the household computer
    And the audit table cannot be written
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    Then the file response status is 503
    And the file response error is "audit_unavailable"
    And no file request was left for the owner

  @server
  Scenario: An owner whose hashes disagree with what was sent is flagged in the audit record
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the owner answers the write reporting the hash of "something else" as the new hash
    Then the audit log has one record for member "mia" with the flag "integrity_mismatch"

  @server
  Scenario: Reading a file is not audited
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When a member reads the computer file "/workspace/notes.md"
    And the owner polls and answers the file request it is given
    Then the audit log has no records

  # ---------------------------------------------------------------- secrets

  @server
  Scenario: A masked secret file is listed but its content is not returned
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file ".env" containing "API_KEY=abc123"
    When a member reads the computer file "/workspace/.env"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    And the file response says "masked" is "true"
    And the file response says "size" is "14"
    And the file response carries no file content
    And the audit log has no records

  @server
  Scenario: A link with an ordinary name to a secret file is masked too
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file ".env" containing "API_KEY=abc123"
    And the live disk of the owner holds a symbolic link "/workspace/config.txt" to ".env"
    When a member reads the computer file "/workspace/config.txt"
    And the owner polls and answers the file request it is given
    Then the file response says "masked" is "true"
    And the file response carries no file content

  @server
  Scenario: A secret the owner did not mask is masked by the Front Door
    Given a live owner is polling for the household computer
    When a member reads the computer file "/workspace/id_rsa"
    And the owner answers the read with the content "PRIVATE KEY" and does not mask it
    Then the file response says "masked" is "true"
    And the file response carries no file content

  @server
  Scenario: Revealing a masked file returns its content and is audited
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file ".env" containing "API_KEY=abc123"
    When member "mia" reveals the computer file "/workspace/.env"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    And the file response says "masked" is "false"
    And the file response says "revealed" is "true"
    And the content response holds "API_KEY=abc123"
    And the file response carries header "Cache-Control" as "private, no-store"
    And the audit log has one record for member "mia" with these fields:
      | field     | value               |
      | operation | reveal              |
      | path      | /workspace/.env     |
      | outcome   | ok                  |
      | source    | live                |
      | revealed  | true                |

  @server
  Scenario: A reveal is refused when the audit record cannot be written
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file ".env" containing "API_KEY=abc123"
    And the audit table cannot be written
    When member "mia" reveals the computer file "/workspace/.env"
    Then the file response status is 503
    And the file response error is "audit_unavailable"
    And no file request was left for the owner

  @server
  Scenario: A revealed secret does not stay in the file operation record
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file ".env" containing "API_KEY=abc123"
    When member "mia" reveals the computer file "/workspace/.env"
    And the owner polls and answers the file request it is given
    Then no file operation record of the organization holds "API_KEY=abc123"

  @server
  Scenario: A secret is revealed from the saved copy and audited as well
    Given the computer disk holds workspace file ".env" containing "API_KEY=abc123"
    And the computer disk is published
    And no owner is running
    When member "mia" reveals the computer file "/workspace/.env"
    Then the content response holds "API_KEY=abc123"
    And the audit log has one record for member "mia" with these fields:
      | field     | value           |
      | operation | reveal          |
      | source    | snapshot        |

  # ---------------------------------------------------------------- who may

  @server
  Scenario: A member of another organization is refused
    Given tenant "other" has user "eve"
    And a live owner is polling for the household computer
    When user "eve" reads the computer file "/workspace/notes.md" of tenant "anthus"
    Then the file response status is 403
    And no file request was left for the owner
    When user "eve" replaces the computer file "/workspace/notes.md" of tenant "anthus" with "x" if it still has the hash of "y"
    Then the file response status is 403
    And the audit log has no records

  @server
  Scenario: A caller with no member token is refused
    When a caller with no credential reads the computer file "/workspace/notes.md"
    Then the file response status is 403

  @server
  Scenario: A supervisor token does not open the member file routes
    Given a live owner is polling for the household computer
    When the owner presents its supervisor token to read the computer file "/workspace/notes.md"
    Then the file response status is 403

  @server
  Scenario: A member of a suspended organization cannot edit
    Given the organization "anthus" is suspended
    And a live owner is polling for the household computer
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    Then the file response status is 403

  @server
  Scenario: A member who asks too often is told to wait
    Given a live owner is polling for the household computer
    When member "mia" makes 31 write requests within one minute
    Then the 31st file response status is 429
    And the 31st file response carries a "Retry-After" header
    And the audit log has no record of the 31st request

  @server
  Scenario: Too many pending file operations are refused at once
    Given a live owner is polling for the household computer
    And 16 file requests are pending that the owner has not taken
    When a member reads the computer file "/workspace/notes.md"
    Then the file response status is 429
    And the file response error is "too_busy"

  @server
  Scenario Outline: A path that is not under /workspace is refused before anything is asked of the owner
    Given a live owner is polling for the household computer
    When a member reads the computer file "<path>"
    Then the file response status is 400
    And the file response error is "invalid_path"
    And no file request was left for the owner

    Examples:
      | path                    |
      | /etc/passwd             |
      | /workspace/../etc/passwd |
      | workspace/notes.md      |

  # ---------------------------------------------------------------- the owner side of the protocol

  @server
  Scenario: A result for an abandoned operation is refused
    Given a live owner is polling for the household computer
    When a member reads the computer file "/workspace/notes.md" and the owner does not answer for 8 seconds
    And the owner posts a result for that operation
    Then the result is refused with code "operation_closed"

  @server
  Scenario: A result is recorded once
    Given a live owner is polling for the household computer
    When a member reads the computer file "/workspace/notes.md"
    And the owner polls and answers the file request it is given
    And the owner posts the same result again
    Then the result is acknowledged and nothing changes

  # ---------------------------------------------------------------- fast poll

  # ---------------------------------------------------------------- the web app

  @web
  Scenario: The panel says whether it shows the live computer or a saved copy
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    When the member opens the Files tab
    Then the panel shows the source "Live from the computer"
    When the computer is off
    And the member refreshes the files
    Then the panel shows the source "Computer is off. Showing the copy saved 5 minutes ago"

  @web
  Scenario: A fallback to the saved copy says so and tries again
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the next live read times out
    When the member opens the Files tab
    Then the panel shows "Could not reach the running computer. Showing the saved copy"
    And the panel asks again after 2 seconds
    And the editor is not offered

  @web
  Scenario: A member edits and saves a file
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the live computer holds workspace file "notes.md" containing "first draft"
    When the member opens "/workspace/notes.md" and chooses Edit
    And the member replaces the text with "second draft" and chooses Save
    Then the panel shows "Saved on the computer"
    And the live computer holds workspace file "notes.md" containing "second draft"

  @web
  Scenario: Leaving an edited file asks first
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the member is editing "/workspace/notes.md" and has changed the text
    When the member chooses Back to folder
    Then the panel asks whether to discard the changes

  @web
  Scenario: A conflict shows a banner with the other version
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the member is editing "/workspace/plan.md" containing "v1" and has typed "v2 from Mia"
    And the bot changed that file to "v2 from Pi" on the computer
    When the member chooses Save
    Then the panel shows "This file changed on the computer while you were editing"
    And the panel shows the other version "v2 from Pi" next to the member's text
    And the member's text is still in the editor
    When the member chooses Overwrite with mine
    Then the live computer holds workspace file "plan.md" containing "v2 from Mia"

  @web
  Scenario: The panel warns when Pi changed the open file a moment ago
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the member is editing "/workspace/plan.md"
    When a tool call of the running turn writes "/workspace/plan.md"
    Then the panel shows "Pi changed this a moment ago"
    And the Save button is still available

  @web
  Scenario: The panel warns when the open file changed on the computer without a tool call
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the member is editing "/workspace/plan.md"
    When the file changes on the computer and 5 seconds go by
    Then the panel shows "Pi changed this a moment ago"

  @web
  Scenario: A masked file asks before it is revealed
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the live computer holds workspace file ".env" containing "API_KEY=abc123"
    When the member opens "/workspace/.env"
    Then the panel shows "This file looks like it holds a secret and is not shown"
    And the panel does not contain "abc123"
    When the member chooses Reveal and confirms that it is recorded
    Then the panel shows "API_KEY=abc123"
    And the audit log has a reveal record for the member
    When the member chooses Hide
    Then the panel does not contain "abc123"

  @web
  Scenario: The panel tells the computer it is open and stops when it is hidden
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    When the member opens the Files tab
    Then the panel tells the computer it is open
    And the panel tells the computer again every 15 seconds
    When the member switches to another tab
    Then the panel tells the computer it is closed
    And the panel stops telling the computer

  @web
  Scenario: A file that is too large to edit offers no editor
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the live computer holds a file "/workspace/big.txt" of 300000 bytes
    When the member opens "/workspace/big.txt"
    Then the editor is not offered
    And the panel says the file is too large to edit here

  @web
  Scenario: A member edits a file while the computer is off
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And the saved copy holds workspace file "notes.md" containing "first draft"
    When the member opens "/workspace/notes.md" and chooses Edit
    And the member replaces the text with "second draft" and chooses Save
    Then the panel shows "Saved. Your change will be applied when the computer starts"
    And no computer was started
    When the member opens "/workspace/notes.md"
    Then the panel shows "second draft"

  @web
  Scenario: The panel marks a file that is waiting for the computer
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And a pending edit of "/workspace/notes.md" made while the computer was off
    When the member opens the Files tab
    Then the listing marks "notes.md" as "Edited, waiting for the computer"

  @web
  Scenario: A conflict made while the computer was off shows both versions
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And a pending edit of "/workspace/plan.md" that conflicts with a newer saved version
    When the member opens "/workspace/plan.md"
    Then the panel shows "Your edit conflicts with a newer version of this file"
    And the panel shows the saved version next to the member's text
    When the member chooses Use theirs
    Then the panel shows the saved version only

  @web
  Scenario: An edit made while the computer is starting is tried again
    Given the enabled workspace web SPA with the computer starting for "ryan@example.com" in "Anthus Labs"
    And the next save is answered "computer_starting" with a retry time of 2 seconds
    When the member saves a changed file
    Then the panel shows "The computer is starting; your text is kept"
    And the panel tries to save again after 2 seconds
    And the member's text is still in the editor

  @web
  Scenario: A member deletes a file while the computer is off
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And the saved copy holds workspace file "notes.md" containing "x"
    When the member chooses Delete on "/workspace/notes.md" and confirms
    Then the panel shows "Deleted. This will be applied when the computer starts"
    And the listing no longer shows "notes.md"
    And no computer was started

  @web
  Scenario: A member renames a file and sees it at once
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And the saved copy holds workspace file "old.md" containing "x"
    When the member chooses Rename on "/workspace/old.md" and types "new.md"
    Then the listing shows "new.md" marked "Renamed, waiting for the computer" and not "old.md"

  @web
  Scenario: A member creates a folder
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    When the member chooses New folder and types "docs"
    Then the listing shows the folder "docs" marked "New, waiting for the computer"

  @web
  Scenario: The panel asks before deleting a folder that is not empty and offers it only to the owner role
    Given the enabled workspace web SPA with the computer off for "mia@example.com" who is a member in "Anthus Labs"
    And the saved copy holds a folder "old" with 3 files
    Then the folder "old" offers no recursive delete
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" who is the organization owner in "Anthus Labs"
    When the member chooses Delete on the folder "/workspace/old"
    Then the panel asks "Delete old and the 3 files in it?"
    And the folder is deleted only after the member confirms

  @web
  Scenario: The panel lists the changes waiting for the computer and discards one
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And pending changes: a delete of "/workspace/a.txt" and a new folder "/workspace/docs"
    When the member opens Pending changes
    Then the panel lists "Deleted a.txt" and "New folder docs"
    When the member discards "Deleted a.txt"
    Then the listing shows "a.txt" again

  # ---------------------------------------------------------------- the whole path

  @end-to-end
  Scenario: A member edits a file while no turn runs and the bot reads it back
    Given the model is scripted to call "read_workspace" with:
      """
      {"path": "/workspace/notes.md"}
      """
    And the model is scripted to answer "I read it."
    And a supervisor is running for the household computer
    And the live disk holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the supervisor polls until the file request is answered
    Then the file response status is 200
    When bot "Researcher" is asked "read the notes"
    And bot "Researcher" works its turn until it waits for the computer
    And the supervisor polls until it is served
    Then the model saw "second draft" in its next request

  @end-to-end
  Scenario: Both sides edit the same file at once and exactly one edit stands
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/plan.md", "content": "from the bot"}
      """
    And the model is scripted to answer "Written."
    And a supervisor is running for the household computer
    And the live disk holds workspace file "plan.md" containing "v1"
    And member "mia" has read the computer file "/workspace/plan.md" and holds its hash
    When bot "Researcher" is asked "rewrite the plan"
    And bot "Researcher" works its turn until it waits for the computer
    And the supervisor polls until it is served
    And member "mia" replaces the computer file "/workspace/plan.md" with "from Mia" if it still has the hash of "v1"
    And the supervisor polls until the file request is answered
    Then the file response status is 409
    And the live disk holds workspace file "plan.md" containing "from the bot"

  @end-to-end
  Scenario: An edit is in the saved copy after the quiet publish
    Given a supervisor is running for the household computer
    And the live disk holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the supervisor polls until the file request is answered
    And 31 seconds go by
    Then the supervisor published the snapshot
    And the saved copy holds workspace file "notes.md" containing "second draft"

  @end-to-end
  Scenario: An edit made while the computer is off is applied on the next hydrate and the bot sees it
    Given the model is scripted to call "read_workspace" with:
      """
      {"path": "/workspace/notes.md"}
      """
    And the model is scripted to answer "I read it."
    And the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And bot "Researcher" is asked "read the notes"
    And bot "Researcher" works its turn until it waits for the computer
    And a supervisor is started for the household computer
    And the supervisor polls until it is served
    Then the model saw "second draft" in its next request
    And the file "notes.md" on the live disk contains "second draft"

  @end-to-end
  Scenario: The overlay is empty after the publish that holds the edit
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    And member "mia" replaced "/workspace/notes.md" with "second draft" while the computer was off
    And a supervisor is running for the household computer
    When 6 seconds go by
    Then the supervisor published the snapshot
    And the overlay is empty and not sealed by a stopped owner
    And the saved copy holds workspace file "notes.md" containing "second draft"

  @end-to-end
  Scenario: The overlay survives a crash of the owner before it publishes
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    And member "mia" replaced "/workspace/notes.md" with "second draft" while the computer was off
    And a supervisor is running for the household computer
    And the supervisor applied the overlay but has not published
    When the task is killed without a stopped report
    And 31 seconds go by
    Then a member reads the computer file "/workspace/notes.md" and gets "second draft" from the snapshot with the overlay
    And the overlay still holds the entry for "/workspace/notes.md"
    When a new supervisor is started and hydrates
    Then the file "notes.md" on the live disk contains "second draft"

  @end-to-end
  Scenario: A file deleted and a file renamed while the computer is off are seen that way by the bot
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "ls /workspace"}
      """
    And the model is scripted to answer "Listed."
    And the computer disk holds workspace file "gone.txt" containing "g"
    And the computer disk holds workspace file "old.txt" containing "o"
    And the computer disk is published
    And no owner is running
    And member "mia" deleted "/workspace/gone.txt" and renamed "/workspace/old.txt" to "/workspace/new.txt" while the computer was off
    When bot "Researcher" is asked "list the workspace"
    And bot "Researcher" works its turn until it waits for the computer
    And a supervisor is started for the household computer
    And the supervisor polls until it is served
    Then the model saw "new.txt" in its next request
    And the model's next request does not contain "gone.txt"
    And the model's next request does not contain "old.txt"
