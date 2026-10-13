Feature: Members view and edit the files of the computer, live when it runs and saved when it is off

  As a member of an organization
  I want to see the files on the computer as they are right now and to change one
  So that I can read what my bots made before it is saved, and fix a file without sending a chat message

  These are the member routes of the live file protocol (docs/LIVE_FILES_PROTOCOL.md sections 6.2, 7.2, 7.3, 7.5 and 7.7;
  the wire schemas are in host-protocol/src/live-files.ts). One predicate chooses the source. A running owner that has
  finished hydrating and speaks protocol 2 answers: the Front Door leaves a file request in the table, the owner takes it in
  its next poll and posts the result, and the Front Door waits for it at most eight seconds. Any other computer is answered
  from the saved snapshot with the edit overlay merged over it, and an edit made then goes into the overlay and starts
  nothing. A member edits with an optimistic hash check; every edit and every reveal of a masked file is written to an audit
  record by the Front Door before the owner is asked, in a key family neither owner role can reach. The owner side of the
  protocol (the poll, the result route, the fast pace, the idle stop) is in computer_file_live_owner.feature and the overlay
  seal and clear in computer_file_overlay.feature.

  Background:
    Given an empty control plane
    And a fake owner credential broker
    And the organization is homed in the deployment account
    And the household computer of tenant "anthus" with members "ryan" and "mia"
    And an edit overlay over a snapshot bucket

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
    And the file response says "fallback_reason" is "null"
    And the content response holds "second draft"
    And the content response has the SHA-256 of "second draft" and the same ETag

  @server
  Scenario: A live listing shows a file the saved copy does not have
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "a.txt" containing "a"
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
    And the file response says "fallback_reason" is "null"
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
    And the file response says "stale" is "true"
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
    And the content response holds "saved"
    And the file request was abandoned and its payload removed

  @server
  Scenario: A request the owner took but did not answer in time falls back to the saved copy
    Given the computer disk holds workspace file "notes.md" containing "saved"
    And the computer disk is published
    And a live owner is polling for the household computer
    When a member reads the computer file "/workspace/notes.md"
    And the owner polls and holds the file request for 9 seconds
    Then the file response says "source" is "snapshot"
    And the file response says "fallback_reason" is "owner_timeout"
    When the owner posts the result of the request it held
    Then no file request is left in the table

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
    And the next poll of the owner is answered with a pace of 1 second

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
    When a member lists the computer files at "/workspace"
    And the owner polls and answers the file request it is given
    Then the listing shows "big.bin" as a file of 9000000 bytes

  @server
  Scenario: A listing is cut at 2000 entries
    Given a live owner is polling for the household computer
    And the live disk of the owner holds 2500 files in "/workspace/many"
    When a member lists the computer files at "/workspace/many"
    And the owner polls and answers the file request it is given
    Then the listing has 2000 entries and truncated is true

  @server
  Scenario: The saved copy is answered with a modification time and an editable flag
    Given the computer disk holds workspace file "notes.md" containing "saved"
    And the computer disk is published
    And no owner is running
    When a member reads the computer file "/workspace/notes.md"
    Then the file response says "editable" is "true"
    And the file response says "revealed" is "false"
    And the file response says "overlay" is "none"
    And the file response has a modification time
    When a member stats the computer file "/workspace/notes.md"
    Then the file response says "stale" is "false"
    And the stat entry has a modification time

  # ---------------------------------------------------------------- writing to the running computer

  @server
  Scenario: A member edits a file and the owner has it
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    And the file response says "source" is "live"
    And the file response says "created" is "false"
    And the file response says "backed_up" is "false"
    And the file response says "sha256" is the hash of "second draft"
    And the file response says "previous_sha256" is the hash of "first draft"
    And the file response carries the ETag of "second draft"
    And the live disk of the owner now has workspace file "notes.md" containing "second draft"
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
    And the live disk of the owner now has workspace file "notes.md" containing "first draft"

  @server
  Scenario: A write without a precondition is refused before it reaches the owner
    Given a live owner is polling for the household computer
    When member "mia" replaces the computer file "/workspace/notes.md" with "mine" and sends no precondition
    Then the file response status is 428
    And the file response error is "precondition_required"
    And no file request was left for the owner

  @server
  Scenario Outline: A write with a malformed precondition is refused before it reaches the owner
    Given a live owner is polling for the household computer
    When member "mia" replaces the computer file "/workspace/notes.md" with "mine" sending the header "<header>" as <value>
    Then the file response status is <status>
    And the file response error is "<error>"
    And no file request was left for the owner

    Examples:
      | header        | value                                                                    | status | error                 |
      | If-Match      | *                                                                        | 400    | invalid_body          |
      | If-Match      | W/"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"      | 400    | invalid_body          |
      | If-Match      | "not-a-hash"                                                             | 400    | invalid_body          |
      | If-None-Match | "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"      | 400    | invalid_body          |

  @server
  Scenario: A write that names both preconditions is refused before it reaches the owner
    Given a live owner is polling for the household computer
    When member "mia" replaces the computer file "/workspace/notes.md" with "mine" sending both preconditions
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
    And the live disk of the owner now has workspace file "taken.md" containing "old"

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
    And the live disk of the owner now has workspace file "plan.md" containing "v2 from Pi"
    When member "mia" replaces the computer file "/workspace/plan.md" with "v2 from Mia" if it still has the hash of "v2 from Pi"
    And the owner polls and answers the file request it is given
    Then the file response status is 200
    And the live disk of the owner now has workspace file "plan.md" containing "v2 from Mia"

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
      | path                                 |
      | /workspace/.git/config               |
      | /workspace/app/.git/hooks/pre-commit |
      | /workspace/.git                      |

  @server
  Scenario: A write the helper refuses after following a link is a refusal
    Given a live owner is polling for the household computer
    When member "mia" creates the computer file "/workspace/notes.md" with "x"
    And the owner polls and answers the file request with the error "outside_workspace"
    Then the file response status is 403
    And the file response error is "path_refused"
    And the audit log has a record for member "mia" with outcome "refused" and error "outside_workspace"

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
    Given a live owner that polls every 10 seconds and last polled 9 seconds ago
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft" and the owner does not answer for 8 seconds
    Then the file response status is 504
    And the file response error is "owner_timeout"
    And the audit log has a record for member "mia" with outcome "failed" and error "owner_timeout"
    When the owner polls
    Then the poll response carries no file request
    And the live disk of the owner now has workspace file "notes.md" containing "first draft"

  @server
  Scenario: A write the owner took but did not answer is reported as unknown and audited when the answer comes
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the owner polls and holds the file request for 16 seconds
    Then the file response status is 504
    And the file response error is "outcome_unknown"
    When the owner posts the result of the request it held
    Then the audit log has a record for member "mia" with outcome "ok"
    And no file request is left in the table

  @server
  Scenario: A write the owner answers within the extra seven seconds is a success
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the owner polls and answers the file request it is given after 10 seconds
    Then the file response status is 200
    And the live disk of the owner now has workspace file "notes.md" containing "second draft"
    And the audit log has a record for member "mia" with outcome "ok"

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
  Scenario: An edit made after a hydrating owner sealed the overlay waits for the owner
    Given the computer disk is published
    And an owner of the household computer is hydrating
    And the owner sealed the overlay
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    Then the file response status is 503
    And the file response error is "computer_starting"
    And the file response says "retry_after_ms" is "2000"
    And the audit log has no records

  @server
  Scenario: An edit made through the route while the owner extracts the snapshot is in the set the owner seals
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And an owner of the household computer is hydrating
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    Then the file response status is 200
    And the file response says "source" is "overlay"
    When the owner seals the overlay
    Then the sealed entries are exactly:
      | path                | sha256                     |
      | /workspace/notes.md | the hash of "second draft" |

  @server
  Scenario: A member's read that loses the race with an idle stop is answered from the saved copy
    Given the computer disk holds workspace file "notes.md" containing "saved"
    And the computer disk is published
    And a live owner is polling for the household computer
    When a member reads the computer file "/workspace/notes.md" while the owner's idle stop is approved between the request being judged and being queued
    Then the member's file request is not queued
    And the file response says "source" is "snapshot"
    And the file response says "fallback_reason" is "owner_stopping"

  @server
  Scenario: A member's write that loses the race with an idle stop waits for the next owner
    Given a live owner is polling for the household computer
    When member "mia" creates the computer file "/workspace/fresh.md" while the owner's idle stop is approved between the request being judged and being queued
    Then the member's file request is not queued
    And the file response status is 503
    And the file response error is "computer_stopping"
    And the audit log has a record for member "mia" with outcome "failed" and error "owner_stopping"

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
    And the file response says "editable" is "true"
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
    When a member lists the computer files at "/workspace"
    Then the file response status is 404
    And the file response error is "no_snapshot"
    When member "mia" creates the computer file "/workspace/first.md" with "hello"
    Then the file response status is 200
    When a member reads the computer file "/workspace/first.md"
    Then the content response holds "hello"
    When a member lists the computer files at "/workspace"
    Then the listing shows these entries in order:
      | name     | kind |
      | first.md | file |

  @server
  Scenario: A stale-hash edit made while the computer is off is refused
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    When member "mia" replaces the computer file "/workspace/notes.md" with "mine" if it still has the hash of "an older draft"
    Then the file response status is 409
    And the file response error is "precondition_failed"
    And the file response says "current_sha256" is the hash of "first draft"
    And the edit overlay holds no entry for "/workspace/notes.md"

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
    And the edit overlay holds "from Mia" for "/workspace/plan.md"

  @server
  Scenario: Two members editing different files at the same instant both stand
    Given the computer disk holds workspace file "a.md" containing "a"
    And the computer disk holds workspace file "b.md" containing "b"
    And the computer disk is published
    And no owner is running
    When member "mia" and member "ryan" replace "/workspace/a.md" and "/workspace/b.md" at the same instant
    Then both file responses have status 200
    And the edit overlay holds "mia was here" for "/workspace/a.md"
    And the edit overlay holds "ryan was here" for "/workspace/b.md"

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
    And the edit overlay holds no entry for "/workspace/app/node_modules/x/index.js"

  @server
  Scenario: A link in the saved copy cannot be edited while the computer is off
    Given the computer disk holds workspace file "real.txt" containing "one"
    And the computer disk holds workspace link "alias.txt" pointing to "real.txt"
    And the computer disk is published
    And no owner is running
    When member "mia" creates the computer file "/workspace/alias.txt" with "two"
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
    And the edit overlay holds no entry for "/workspace/.git/config"
    And the audit log has a record for member "mia" with outcome "refused" and error "path_refused"

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
    And the audit log has a record for member "mia" with these fields:
      | field     | value   |
      | operation | reveal  |
      | source    | overlay |
      | outcome   | ok      |

  @server
  Scenario: A conflict is shown with both versions and is replaced only on purpose
    Given the computer disk holds workspace file "plan.md" containing "v1"
    And the computer disk is published
    And no owner is running
    And member "mia" saved "/workspace/plan.md" as "from Mia" in the overlay
    And the computer disk holds workspace file "plan.md" containing "from the host"
    And the computer disk is published
    When a member reads the computer file "/workspace/plan.md"
    Then the content response holds "from the host"
    And the file response says "overlay" is "conflict"
    And the file response says "mine_sha256" is the hash of "from Mia"
    When a member reads the computer file "/workspace/plan.md" as the version "mine"
    Then the content response holds "from Mia"
    When member "mia" replaces the computer file "/workspace/plan.md" with "from Mia again" if it still has the hash of "from the host"
    Then the file response status is 200
    When a member reads the computer file "/workspace/plan.md"
    Then the content response holds "from Mia again"
    And the file response says "overlay" is "pending"

  @server
  Scenario: A computer in a customer account cannot be edited while it is off
    Given the organization is homed in the account "111122223333" with no cross-account role
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

  # ---------------------------------------------------------------- audit

  @server
  Scenario: An edit lands in the audit log
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the owner polls and answers the file request it is given
    Then the audit log has one record for member "mia" with these fields:
      | field         | value                      |
      | operation     | write                      |
      | path          | /workspace/notes.md        |
      | outcome       | ok                         |
      | source        | live                       |
      | sha256_before | the hash of "first draft"  |
      | sha256_after  | the hash of "second draft" |
      | bytes         | 12                         |
      | revealed      | false                      |
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
  Scenario: An edit is refused while the computer is off when the audit record cannot be written
    Given the computer disk is published
    And no owner is running
    And the audit table cannot be written
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    Then the file response status is 503
    And the file response error is "audit_unavailable"
    And the edit overlay holds no entry for "/workspace/fresh.md"

  @server
  Scenario: An owner whose hashes disagree with what was sent is flagged in the audit record
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the owner polls and answers the write reporting the hash of "something else" as the new hash
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
    And the file response says "editable" is "false"
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
    And the owner polls and answers the read with the content "PRIVATE KEY" and does not mask it
    Then the file response says "masked" is "true"
    And the file response carries no file content
    And the response body does not contain "PRIVATE KEY"

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
      | field     | value           |
      | operation | reveal          |
      | path      | /workspace/.env |
      | outcome   | ok              |
      | source    | live            |
      | revealed  | true            |

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
      | field     | value    |
      | operation | reveal   |
      | source    | snapshot |

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
  Scenario: An integration-test session of a member can write a file and the audit names its user id
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    And the development environment accepts an integration-test session of member "pipeline" on the household computer
    When the integration-test session replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    Then the file response status is 200
    And the audit log has a record for member "pipeline" with these fields:
      | field     | value               |
      | operation | write               |
      | path      | /workspace/notes.md |
      | outcome   | ok                  |
      | source    | overlay             |

  @server
  Scenario: A worker credential cannot write a file
    Given a live owner is polling for the household computer
    When the owner presents its supervisor token to replace the computer file "/workspace/notes.md" with "mine"
    Then the file response status is 403
    And the audit log has no records

  @server
  Scenario: A member of a suspended organization cannot edit
    Given the organization of tenant "anthus" is suspended
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    Then the file response status is 403
    And the audit log has no records

  @server
  Scenario: A member who asks too often is told to wait
    Given a live owner is polling for the household computer
    When member "mia" makes 31 write requests within one minute
    Then the 31st file response status is 429
    And the 31st file response carries a "Retry-After" header
    And the audit log has no records

  @server
  Scenario: A member who reveals too often is told to wait
    Given the computer disk holds workspace file ".env" containing "API_KEY=abc123"
    And the computer disk is published
    And no owner is running
    When member "mia" reveals the computer file "/workspace/.env" 11 times within one minute
    Then the 11th file response status is 429
    And the 11th file response carries a "Retry-After" header

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
      | path                     |
      | /etc/passwd              |
      | /workspace/../etc/passwd |
      | workspace/notes.md       |

  # ---------------------------------------------------------------- the owner side as the member sees it

  @server
  Scenario: A result for an abandoned read is refused
    Given a live owner is polling for the household computer
    When a member reads the computer file "/workspace/notes.md" and the owner does not answer for 8 seconds
    And the owner answers the request that was abandoned
    Then the owner's answer is refused with code "operation_closed"

  @server
  Scenario: An answer the Front Door has read is not recorded again
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "notes.md" containing "x"
    When a member reads the computer file "/workspace/notes.md"
    And the owner polls and answers the file request it is given
    And the owner posts the answer it gave again
    Then the owner's answer is refused with code "operation_closed"
    And no file request is left in the table

  @server
  Scenario: A watch ping on a running computer opens the fast pace and starts nothing
    Given a live owner is polling for the household computer
    When a member's Files panel pings that it is open through the watch route
    Then the file response status is 200
    And the file response says "state" is "live"
    And no computer start job is queued
    And the next poll of the owner is answered with a pace of 1 second

  @server
  Scenario: A watch ping on a computer that is off says so and starts nothing
    Given no owner is running
    When a member's Files panel pings that it is open through the watch route
    Then the file response says "state" is "off"
    And no computer start job is queued
