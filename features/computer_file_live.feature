# DRAFT. Not in features/cucumber-features.txt and not run by any gate: no step definitions exist yet.
# The contract is docs/LIVE_FILES_PROTOCOL.md; the traceability table in its section 13 maps every
# requirement to a scenario name below. Whoever builds a part writes the steps for the tag they own
# (@server, @supervisor, @web, @end-to-end) and adds this file to the list together with those steps.
# Scenario names are the contract: do not rename one without changing the table.
# Moved to computer_file_live_owner.feature (run, with steps): the poll delivery, result route, fast poll, idle stop veto and
# role policy scenarios of LF-15, LF-21, LF-28 to LF-31. Moved to computer_file_overlay.feature (run): LF-53 to LF-56 and the
# store-level halves of LF-57. Moved to computer_file_live_member.feature (run, part A2): LF-1 to LF-14, LF-17 to LF-20,
# LF-22 to LF-27, LF-47 to LF-52, the member side of LF-57 and LF-58, and the member routes of the four scenarios that were
# split with the owner side. What remains below is the delete, rename and new folder routes (part A4), the two policy
# scenarios of part B, and the supervisor, web and end-to-end scenarios of the parts that own those tags.

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

  # ---------------------------------------------------------------- editing while the computer is off (the edit overlay)

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

  # ---------------------------------------------------------------- the container

  @supervisor
  Scenario: The owner applies the overlay after extraction and before any turn
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    And a turn is already parked for the computer
    When the supervisor starts and hydrates
    Then the supervisor extracted the snapshot, then sealed the overlay, then applied the entries
    And the workspace file "notes.md" contains "second draft"
    And the supervisor accepted no dispatch before the apply ended
    And the supervisor reported "hydrating" until the apply ended

  @supervisor
  Scenario: The owner applies the overlay when the local cache matched
    Given the local cache already holds the published snapshot
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    When the supervisor starts and hydrates
    Then the snapshot was not extracted again
    And the workspace file "notes.md" contains "second draft"

  @supervisor
  Scenario: The owner applies the overlay when no snapshot was ever published
    Given no snapshot was ever published
    And the overlay holds "hello" for a new file "/workspace/first.md"
    When the supervisor starts and hydrates
    Then the workspace file "first.md" contains "hello"

  @supervisor
  Scenario: A turn that arrives right after the hydrate runs while the entries wait to be cleared
    Given the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    And a turn is already parked for the computer
    When the supervisor starts, hydrates and polls until it is served
    Then the turn ran
    And the overlay still holds the entry for "/workspace/notes.md"
    And the supervisor did not publish while the turn ran

  @supervisor
  Scenario: The owner asks to clear only after the publish that holds the edits is recorded
    Given the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    When the supervisor starts and hydrates
    Then the supervisor asked to clear nothing yet
    When 5 seconds go by with the supervisor idle
    Then the supervisor published the snapshot
    And after the publish was recorded the supervisor asked to clear exactly "/workspace/notes.md" at the revision and hash it applied

  @supervisor
  Scenario: A clear that was lost is asked again and before the stopped report
    Given the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    And the control plane does not answer the clear request
    When the supervisor starts, hydrates and publishes
    And 10 seconds go by
    Then the supervisor asked to clear again
    When the supervisor is told to stop
    Then the supervisor asked to clear before it reported the computer stopped

  @supervisor
  Scenario: An edit that equals what the snapshot already holds is cleared without a publish
    Given the saved snapshot already holds "second draft" in "/workspace/notes.md"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    When the supervisor starts and hydrates
    Then the supervisor asked to clear "/workspace/notes.md" at once
    And the supervisor did not publish

  @supervisor
  Scenario: The owner finds a third version on the disk and does not overwrite it
    Given the saved snapshot holds workspace file "plan.md" containing "from the host"
    And the overlay holds "from Mia" for "/workspace/plan.md" with base hash of "v1"
    When the supervisor starts and hydrates
    Then the workspace file "plan.md" contains "from the host"
    And the supervisor reported a conflict for "/workspace/plan.md" with the disk hash of "from the host"
    And the supervisor asked to clear nothing

  @supervisor
  Scenario: An overlay that cannot be read fails the hydrate
    Given the overlay holds an entry whose blob is missing
    When the supervisor starts and hydrates
    Then the supervisor exits with code 8
    And no turn was served

  @supervisor
  Scenario: An overlay blob that does not hash to its entry fails the hydrate
    Given the overlay holds an entry whose blob holds other bytes
    When the supervisor starts and hydrates
    Then the supervisor exits with code 8
    And the workspace was not written

  @supervisor
  Scenario: The overlay is applied through the file helper and cannot reach outside the workspace
    Given the saved snapshot holds a symbolic link "leak" to a file outside the workspace
    And the overlay holds "overwritten" for "/workspace/leak" with base hash of the link target
    When the supervisor starts and hydrates
    Then the outside file is unchanged
    And the supervisor reported a conflict for "/workspace/leak"

  @supervisor
  Scenario: The owner applies new folders, renames, edits and deletes in that order
    Given the saved snapshot holds workspace file "old/a.txt" containing "a" and "gone.txt" containing "g" and "edit.txt" containing "e1" and "mv.txt" containing "m"
    And the overlay holds a mkdir of "/workspace/docs"
    And the overlay holds a move of the folder "/workspace/old" to "/workspace/new"
    And the overlay holds a move of "/workspace/mv.txt" to "/workspace/docs/mv.txt"
    And the overlay holds "e2" for "/workspace/edit.txt" with base hash of "e1"
    And the overlay holds a delete of "/workspace/gone.txt" with base hash of "g"
    When the supervisor starts and hydrates
    Then the helper was asked for these operations in order: mkdir, rename, rename, write, unlink
    And the workspace has "new/a.txt", "docs/mv.txt" and "edit.txt" containing "e2" and has not "old", "mv.txt" or "gone.txt"
    And no turn was served before the last operation ended

  @supervisor
  Scenario: The owner does not rename onto an existing path
    Given the saved snapshot holds workspace file "a.txt" containing "a" and "b.txt" containing "other"
    And the overlay holds a move of "/workspace/a.txt" to "/workspace/b.txt" with the hash of "a"
    When the supervisor starts and hydrates
    Then the workspace file "b.txt" contains "other" and the workspace file "a.txt" contains "a"
    And the supervisor reported a conflict for "/workspace/b.txt" with reason "collision"

  @supervisor
  Scenario: The owner does not delete a file that changed since it was seen
    Given the saved snapshot holds workspace file "a.txt" containing "a changed by the host"
    And the overlay holds a delete of "/workspace/a.txt" with base hash of "a"
    When the supervisor starts and hydrates
    Then the workspace file "a.txt" contains "a changed by the host"
    And the supervisor reported a conflict for "/workspace/a.txt" with reason "changed"

  @supervisor
  Scenario: The owner does not delete a folder that gained children
    Given the saved snapshot holds an empty folder "docs" that holds "late.txt" containing "x"
    And the overlay holds a delete of the empty folder "/workspace/docs"
    When the supervisor starts and hydrates
    Then the workspace file "docs/late.txt" contains "x"
    And the supervisor reported a conflict for "/workspace/docs" with reason "not_empty"

  @supervisor
  Scenario: The owner treats a delete whose file is already gone as applied
    Given the saved snapshot holds no file "a.txt"
    And the overlay holds a delete of "/workspace/a.txt" with base hash of "a"
    When the supervisor starts and hydrates
    Then the supervisor reported no conflict
    And the supervisor asked to clear "/workspace/a.txt" at once

  @supervisor
  Scenario: The owner renames a whole folder in one step
    Given the saved snapshot holds 300 files in the folder "big"
    And the overlay holds a move of the folder "/workspace/big" to "/workspace/large" with the tree hash it was shown
    When the supervisor starts and hydrates
    Then the helper was asked for exactly one rename
    And the workspace has 300 files in "large" and no folder "big"

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
