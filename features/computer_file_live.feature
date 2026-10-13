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
# split with the owner side. What remains below is the delete, rename and new folder routes (part A4), the two policy
# scenarios of part B, and the supervisor, web and end-to-end scenarios of the parts that own those tags.
# The overlay at hydrate (LF-57 supervisor side, LF-60 to LF-62, LF-73) moved to computer_file_overlay_supervisor.feature (run).

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
