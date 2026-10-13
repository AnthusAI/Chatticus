# DRAFT. Not in features/cucumber-features.txt and not run by any gate: no step definitions exist yet.
# The contract is docs/LIVE_FILES_PROTOCOL.md; the traceability table in its section 13 maps every
# requirement to a scenario name below. Whoever builds a part writes the steps for the tag they own
# (@server, @supervisor, @web, @end-to-end) and adds this file to the list together with those steps.
# Scenario names are the contract: do not rename one without changing the table.
# The @web scenarios (LF-40 to LF-45, LF-63, LF-75) have moved to features/web_computer_files.feature, which is
# registered and run; their names are unchanged.
# Moved to computer_file_live_owner.feature (run, with steps): the poll delivery, result route, fast poll, idle stop veto and
# role policy scenarios of LF-15, LF-21, LF-28 to LF-31. Moved to computer_file_overlay.feature (run): LF-53 to LF-56 and the
# store-level halves of LF-57. Moved to computer_file_live_member.feature (run, part A2): LF-1 to LF-14, LF-17 to LF-20,
# LF-22 to LF-27, LF-47 to LF-52, the member side of LF-57 and LF-58, and the member routes of the four scenarios that were
# split with the owner side. Moved to computer_file_live_operations.feature (run, part A4): the delete, rename and new folder
# scenarios of LF-65 to LF-72. What remains below is the two policy scenarios of part B, and the supervisor, web and
# end-to-end scenarios of the parts that own those tags.

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
