Feature: The owner applies the edit overlay when it hydrates, and asks for it to be cleared only once a publish holds it
  As a member of an organization
  I want an edit I made while the computer was off to be on the disk before the bot runs anything
  So that the bot sees my change and no change of mine is lost, overwritten or applied twice

  While the computer is off, a member's edit waits in the overlay in the snapshot bucket. When the next owner starts, its
  supervisor extracts the snapshot (or finds its local copy current, or finds that no snapshot was ever published), seals the
  overlay with the Front Door, and applies every entry through the unprivileged file helper before it leaves the hydrating
  state, so no turn runs before the apply ends. It applies new folders, then folder renames, file renames, edits and
  deletes in that order, and every operation carries the precondition the person saw: a file the bot changed since is a
  conflict that is reported and kept, never overwritten, and a path that was already changed to the person's version is
  applied once. The supervisor reads the overlay blobs with its read-only credentials, which cannot write or delete in the
  overlay, so it only ever asks the Front Door to clear: it asks once a publish that began after the apply has succeeded, asks
  again every 10 seconds if the answer was lost, and asks once more before it reports the computer stopped. A blob that cannot be
  read or does not hash to its entry fails the hydrate and the owner does not start. The contract is
  docs/LIVE_FILES_PROTOCOL.md sections 7.7, 7.8 and 9.4, and the wire schemas are in host-protocol/src/edit-overlay.ts.

  Background:
    Given a supervisor over a real computer disk with an edit overlay

  # ---------------------------------------------------------------- when the overlay is applied

  Scenario: The owner applies the overlay after extraction and before any turn
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    And the file helper takes 2 seconds for each operation
    And a turn is already parked for the computer
    When the supervisor starts and hydrates
    Then the supervisor extracted the snapshot, then sealed the overlay, then applied the entries
    And the computer workspace file "notes.md" contains "second draft"
    And the supervisor accepted no dispatch before the apply ended
    And the supervisor reported "hydrating" until the apply ended

  Scenario: The owner applies the overlay when the local cache matched
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the local cache already holds the published snapshot
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    When the supervisor starts and hydrates
    Then the snapshot was not extracted again
    And the computer workspace file "notes.md" contains "second draft"

  Scenario: The owner applies the overlay when no snapshot was ever published
    Given no snapshot was ever published
    And the overlay holds "hello" for a new file "/workspace/first.md"
    When the supervisor starts and hydrates
    Then the computer workspace file "first.md" contains "hello"

  Scenario: A turn that arrives right after the hydrate runs while the entries wait to be cleared
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    And a turn is already parked for the computer
    When the supervisor starts, hydrates and polls until it is served
    Then the turn ran
    And the overlay still holds the entry for "/workspace/notes.md"
    And the supervisor did not publish while the turn ran

  Scenario: An entry that already carries a stored conflict is left alone
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft" flagged as a conflict
    When the supervisor starts and hydrates
    Then the computer workspace file "notes.md" contains "first draft"
    And the supervisor reported no conflict
    And the supervisor asked to clear nothing

  # ---------------------------------------------------------------- clearing

  Scenario: The owner asks to clear only after the publish that holds the edits is recorded
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    When the supervisor starts and hydrates
    Then the supervisor asked to clear nothing yet
    When 5 seconds go by with the supervisor idle
    Then the supervisor published the snapshot
    And after the publish was recorded the supervisor asked to clear exactly "/workspace/notes.md" at the revision it applied

  Scenario: A clear that was lost is asked again and before the stopped report
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    And the control plane does not answer the clear request
    When the supervisor starts, hydrates and publishes
    And 10 seconds go by with the supervisor idle
    Then the supervisor asked to clear again
    When the supervisor is told to stop
    Then the supervisor asked to clear before it reported the computer stopped

  Scenario: An edit that equals what the snapshot already holds is cleared without a publish
    Given the saved snapshot already holds "second draft" in "/workspace/notes.md"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    When the supervisor starts and hydrates
    Then the supervisor asked to clear "/workspace/notes.md" at once
    And the supervisor did not publish

  Scenario: The owner finds a third version on the disk and does not overwrite it
    Given the saved snapshot holds workspace file "plan.md" containing "from the host"
    And the overlay holds "from Mia" for "/workspace/plan.md" with base hash of "v1"
    When the supervisor starts and hydrates
    Then the computer workspace file "plan.md" contains "from the host"
    And the supervisor reported a conflict for "/workspace/plan.md" with the disk hash of "from the host"
    And the supervisor reported a conflict for "/workspace/plan.md" with reason "changed"
    And the supervisor asked to clear nothing

  # ---------------------------------------------------------------- an overlay that cannot be applied safely

  Scenario: An overlay that cannot be read fails the hydrate
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds an entry whose blob is missing
    And a turn is already parked for the computer
    When the supervisor starts and hydrates
    Then it exits with code 8 and logs "snapshot_skipped" with reason "overlay_failed"
    And no turn was served

  Scenario: An overlay blob that does not hash to its entry fails the hydrate
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds an entry whose blob holds other bytes
    When the supervisor starts and hydrates
    Then it exits with code 8 and logs "snapshot_skipped" with reason "overlay_failed"
    And the workspace was not written
    And the computer workspace file "notes.md" contains "first draft"

  Scenario: The overlay is applied through the file helper and cannot reach outside the workspace
    Given the saved snapshot holds a symbolic link "leak" to a file outside the workspace
    And the overlay holds "overwritten" for "/workspace/leak" with base hash of the link target
    When the supervisor starts and hydrates
    Then the outside file is unchanged
    And the supervisor reported a conflict for "/workspace/leak"

  Scenario: A seal that fails once is retried and the overlay is still applied
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    And the control plane answers the first seal with 503 "credentials_unavailable"
    When the supervisor starts and hydrates
    Then the computer workspace file "notes.md" contains "second draft"
    And the supervisor sealed the overlay 2 times

  Scenario: A seal that never succeeds fails the hydrate within its budget
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    And the control plane answers every seal with 503 "credentials_unavailable"
    When the supervisor starts and hydrates
    Then it exits with code 8 and logs "snapshot_skipped" with reason "overlay_failed"
    And the computer workspace file "notes.md" contains "first draft"

  Scenario: A seal refused because a newer owner holds the computer ends the supervisor
    Given the saved snapshot holds workspace file "notes.md" containing "first draft"
    And the overlay holds "second draft" for "/workspace/notes.md" with base hash of "first draft"
    And the control plane answers every seal with 403 "stale_generation"
    When the supervisor starts and hydrates
    Then the supervisor ends as superseded
    And the computer workspace file "notes.md" contains "first draft"

  # ---------------------------------------------------------------- new folders, renames, edits and deletes

  Scenario: The owner applies new folders, renames, edits and deletes in that order
    Given the saved snapshot holds these workspace files:
      | path      | content |
      | old/a.txt | a       |
      | gone.txt  | g       |
      | edit.txt  | e1      |
      | mv.txt    | m       |
    And the overlay holds a mkdir of "/workspace/docs"
    And the overlay holds a move of the folder "/workspace/old" to "/workspace/new" with the tree hash it was shown
    And the overlay holds a move of "/workspace/mv.txt" to "/workspace/docs/mv.txt" with the hash of "m"
    And the overlay holds "e2" for "/workspace/edit.txt" with base hash of "e1"
    And the overlay holds a delete of "/workspace/gone.txt" with base hash of "g"
    And the file helper takes 1 seconds for each operation
    And a turn is already parked for the computer
    When the supervisor starts and hydrates
    Then the helper was asked for these operations in order: mkdir, rename, rename, write, unlink
    And the computer workspace file "new/a.txt" contains "a"
    And the computer workspace file "docs/mv.txt" contains "m"
    And the computer workspace file "edit.txt" contains "e2"
    And the computer workspace has no "old"
    And the computer workspace has no "mv.txt"
    And the computer workspace has no "gone.txt"
    And the supervisor accepted no dispatch before the apply ended

  Scenario: A file edited and renamed as one change creates the new path and removes the old one last
    Given the saved snapshot holds workspace file "draft.txt" containing "v1"
    And the overlay holds "v2" for "/workspace/final.txt" renamed from "/workspace/draft.txt" with the hash of "v1"
    When the supervisor starts and hydrates
    Then the helper was asked for these operations in order: write, unlink
    And the computer workspace file "final.txt" contains "v2"
    And the computer workspace has no "draft.txt"

  Scenario: The owner does not rename onto an existing path
    Given the saved snapshot holds these workspace files:
      | path  | content |
      | a.txt | a       |
      | b.txt | other   |
    And the overlay holds a move of "/workspace/a.txt" to "/workspace/b.txt" with the hash of "a"
    When the supervisor starts and hydrates
    Then the computer workspace file "b.txt" contains "other"
    And the computer workspace file "a.txt" contains "a"
    And the supervisor reported a conflict for "/workspace/b.txt" with reason "collision"

  Scenario: The owner does not delete a file that changed since it was seen
    Given the saved snapshot holds workspace file "a.txt" containing "a changed by the host"
    And the overlay holds a delete of "/workspace/a.txt" with base hash of "a"
    When the supervisor starts and hydrates
    Then the computer workspace file "a.txt" contains "a changed by the host"
    And the supervisor reported a conflict for "/workspace/a.txt" with reason "changed"

  Scenario: The owner does not delete a folder that gained children
    Given the saved snapshot holds workspace file "docs/late.txt" containing "x"
    And the overlay holds a delete of the empty folder "/workspace/docs"
    When the supervisor starts and hydrates
    Then the computer workspace file "docs/late.txt" contains "x"
    And the supervisor reported a conflict for "/workspace/docs" with reason "not_empty"

  Scenario: The owner treats a delete whose file is already gone as applied
    Given the saved snapshot holds workspace file "keep.txt" containing "k"
    And the overlay holds a delete of "/workspace/a.txt" with base hash of "a"
    When the supervisor starts and hydrates
    Then the supervisor reported no conflict
    And the supervisor asked to clear "/workspace/a.txt" at once

  Scenario: The owner treats a rename that is already on the disk as applied
    Given the saved snapshot holds workspace file "b.txt" containing "kept"
    And the overlay holds a move of "/workspace/a.txt" to "/workspace/b.txt" with the hash of "kept"
    When the supervisor starts and hydrates
    Then the supervisor reported no conflict
    And the supervisor asked to clear "/workspace/b.txt" at once

  Scenario: The owner does not make a folder where a file is
    Given the saved snapshot holds workspace file "docs" containing "a file"
    And the overlay holds a mkdir of "/workspace/docs"
    When the supervisor starts and hydrates
    Then the computer workspace file "docs" contains "a file"
    And the supervisor reported a conflict for "/workspace/docs" with reason "kind_mismatch"

  Scenario: The owner reports a put into a folder whose creation conflicted as a collision
    Given the saved snapshot holds workspace file "docs" containing "a file"
    And the overlay holds a mkdir of "/workspace/docs"
    And the overlay holds "x" for a new file "/workspace/docs/n.txt"
    When the supervisor starts and hydrates
    Then the supervisor reported a conflict for "/workspace/docs/n.txt" with reason "collision"
    And the supervisor reported a conflict for "/workspace/docs" with reason "kind_mismatch"

  Scenario: The owner renames a whole folder in one step
    Given the saved snapshot holds 300 files in the folder "big"
    And the overlay holds a move of the folder "/workspace/big" to "/workspace/large" with the tree hash it was shown
    When the supervisor starts and hydrates
    Then the helper was asked for exactly one rename
    And the computer workspace has 300 files in "large" and no folder "big"
