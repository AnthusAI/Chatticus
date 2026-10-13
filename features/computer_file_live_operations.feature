Feature: Members delete, rename and create folders on the computer, live when it runs and saved when it is off

  As a member of an organization
  I want to delete a file, rename a file or a folder, and make a folder, from the Files panel
  So that I can tidy the workplace without sending a chat message, also while the computer is off

  These are the delete, rename and new folder routes of the live file protocol (docs/LIVE_FILES_PROTOCOL.md sections 6.2, 7.3 and
  7.8). They share the member routes' principal, rate class and choice of path: a running owner that can serve takes the
  request through the same queue, wait, audit and abandon rules as a save; any other computer records the change in the edit
  overlay as a tombstone, a move that keeps the content hash (no copy of the file), or an empty directory, judged against the
  effective hash. A delete or a rename carries `If-Match` of the hash the person saw: the content hash of a file, the symlink
  hash of a link, or the tree hash of a folder, which is the `ETag` of `stat`. Creating a folder is idempotent. Any member
  deletes a file, a link or an empty folder, renames, and creates a folder; only the organization owner role deletes a folder
  that is not empty, and only with `recursive=true`. A rename never replaces an existing path.

  Background:
    Given an empty control plane
    And a fake owner credential broker
    And the organization is homed in the deployment account
    And the household computer of tenant "anthus" with members "ryan" and "mia"
    And an edit overlay over a snapshot bucket

  # ---------------------------------------------------------------- the hash a person is shown

  @server
  Scenario: The ETag of a folder is its tree hash and changes with what is inside
    Given the computer disk holds workspace file "old/a.txt" containing "a"
    And the computer disk holds workspace file "old/inner/c.txt" containing "ccc"
    And the computer disk is published
    And no owner is running
    When a member stats the computer folder "/workspace/old"
    Then the file response status is 200
    And the file response carries the ETag of the tree hash of these entries:
      | kind | path        | value |
      | file | a.txt       | 1     |
      | dir  | inner       | 0     |
      | file | inner/c.txt | 3     |
    And the stat entry has the same tree hash
    When member "mia" creates the computer file "/workspace/old/b.txt" with "bb"
    And a member stats the computer folder "/workspace/old"
    Then the file response carries the ETag of the tree hash of these entries:
      | kind | path        | value |
      | file | a.txt       | 1     |
      | file | b.txt       | 2     |
      | dir  | inner       | 0     |
      | file | inner/c.txt | 3     |

  @server
  Scenario: The ETag of a link is its link hash and the ETag of an empty folder is the hash of nothing
    Given the computer disk holds workspace file "real.txt" containing "one"
    And the computer disk holds workspace link "alias.txt" pointing to "real.txt"
    And the computer disk holds an empty folder "empty"
    And the computer disk is published
    And no owner is running
    When a member stats the computer file "/workspace/alias.txt"
    Then the file response carries the ETag of the link to "real.txt"
    When a member stats the computer folder "/workspace/empty"
    Then the file response carries the ETag of the tree hash of these entries:
      | kind | path | value |

  @server
  Scenario: A folder with more than 5000 entries has no tree hash and cannot be deleted or renamed
    Given the computer disk holds 5001 workspace files in directory "big"
    And the computer disk is published
    And no owner is running
    When a member stats the computer folder "/workspace/big"
    Then the file response status is 413
    And the file response error is "too_many_entries"
    When the organization owner "ryan" deletes the computer folder "/workspace/big" recursively if it still has the hash of "anything"
    Then the file response status is 413
    And the file response error is "too_many_entries"

  # ---------------------------------------------------------------- while the computer is off

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
    And the file response says "source" is "overlay"
    And the file response says "backed_up" is "true"
    And the overlay holds a move from "/workspace/old.txt" to "/workspace/new.txt" with the hash of "same bytes" and no blob
    When a member reads the computer file "/workspace/new.txt"
    Then the content response holds "same bytes"
    And the content response has the SHA-256 of "same bytes" and the same ETag
    When a member reads the computer file "/workspace/old.txt"
    Then the file response status is 404
    And the saved snapshot pack was not changed

  @server
  Scenario: A folder created while the computer is off is listed and creating it again is harmless
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" creates the computer folder "/workspace/docs"
    Then the file response status is 200
    And the file response says "created" is "true"
    And the file response says "backed_up" is "true"
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
  Scenario: A new folder cannot be made where a file is, or under a folder that is not there
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" creates the computer folder "/workspace/a.txt"
    Then the file response status is 409
    And the file response error is "already_exists"
    When member "mia" creates the computer folder "/workspace/nowhere/inner"
    Then the file response status is 404
    And the file response error is "parent_missing"
    And the overlay holds no entry

  @server
  Scenario: A delete with a stale hash is refused
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "an older a"
    Then the file response status is 409
    And the file response error is "precondition_failed"
    And the file response says "current_sha256" is the hash of "a"
    And the edit overlay holds no entry for "/workspace/a.txt"

  @server
  Scenario: A delete needs exactly one well formed precondition and a clear recursive flag
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer file "/workspace/a.txt" sending no precondition
    Then the file response status is 428
    And the file response error is "precondition_required"
    When member "mia" deletes the computer file "/workspace/a.txt" sending the header "If-Match" as *
    Then the file response status is 400
    And the file response error is "invalid_body"
    When member "mia" deletes the computer file "/workspace/a.txt" sending the header "If-Match" as W/"0000000000000000000000000000000000000000000000000000000000000000"
    Then the file response status is 400
    And the file response error is "invalid_body"
    When member "mia" deletes the computer file "/workspace/a.txt" with the query "recursive=maybe" if it still has the hash of "a"
    Then the file response status is 400
    And the file response error is "invalid_body"
    And the overlay holds no entry

  @server
  Scenario: A rename without a precondition is refused
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" renames the computer file "/workspace/a.txt" to "/workspace/b.txt" and sends no precondition
    Then the file response status is 428
    And the file response error is "precondition_required"

  @server
  Scenario: A path that is not under /workspace is refused before anything else
    Given the computer disk is published
    And no owner is running
    When member "mia" deletes the computer file "/etc/passwd" if it still has the hash of "x"
    Then the file response status is 400
    And the file response error is "invalid_path"
    When member "mia" renames the computer file "/workspace/a.txt" to "/workspace/../etc/passwd" if it still has the hash of "x"
    Then the file response status is 400
    And the file response error is "invalid_path"
    When member "mia" creates the computer folder "workspace/docs"
    Then the file response status is 400
    And the file response error is "invalid_path"
    And the audit log has no records

  @server
  Scenario: A delete or rename of a path that is not there is not found
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer file "/workspace/missing.txt" if it still has the hash of "a"
    Then the file response status is 404
    And the file response error is "not_found"
    When member "mia" renames the computer file "/workspace/missing.txt" to "/workspace/b.txt" if it still has the hash of "a"
    Then the file response status is 404
    And the file response error is "not_found"
    When member "mia" renames the computer file "/workspace/a.txt" to "/workspace/nowhere/b.txt" if it still has the hash of "a"
    Then the file response status is 404
    And the file response error is "parent_missing"
    And the overlay holds no entry

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
  Scenario: The workspace root cannot be deleted or renamed
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk holds an empty folder "inner"
    And the computer disk is published
    And no owner is running
    When member "ryan" deletes the computer folder "/workspace" if it still has the tree hash it was shown
    Then the file response status is 403
    And the file response error is "path_refused"
    When member "ryan" renames the computer folder "/workspace" to "/workspace/inner/root" if it still has the tree hash it was shown
    Then the file response status is 403
    And the file response error is "path_refused"
    And the overlay holds no entry

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
    And the overlay holds no entry
    When member "mia" deletes the computer folder "/workspace/old" without recursion if it still has the tree hash it was shown
    Then the file response status is 409
    And the file response error is "directory_not_empty"
    When the organization owner "ryan" deletes the computer folder "/workspace/old" recursively if it still has the tree hash it was shown
    Then the file response status is 200
    And the file response says "directory" is "true"
    And the file response says "removed" is "3"
    And the overlay holds one delete of the folder "/workspace/old" with the tree hash of the saved copy
    When a member lists the computer files at "/workspace"
    Then the listing is empty

  @server
  Scenario: A refused folder delete is audited as refused
    Given the computer disk holds workspace file "old/a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" deletes the computer folder "/workspace/old" recursively if it still has the tree hash it was shown
    Then the file response status is 403
    And the audit log has a record for member "mia" with outcome "refused" and error "owner_role_required"

  @server
  Scenario: A member renames a folder that is not empty
    Given the computer disk holds workspace file "old/a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    When member "mia" renames the computer folder "/workspace/old" to "/workspace/new" if it still has the tree hash it was shown
    Then the file response status is 200
    And the file response says "directory" is "true"
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
  Scenario: A folder with a change inside it cannot be renamed until the change is applied
    Given the computer disk holds workspace file "old/a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    And member "mia" created "/workspace/old/new.txt" with "n" while the computer was off
    When member "mia" renames the computer folder "/workspace/old" to "/workspace/fresh" if it still has the tree hash it was shown
    Then the file response status is 409
    And the file response error is "path_busy"

  @server
  Scenario: A recursive delete is refused while a pending change takes a file out of the folder
    Given the computer disk holds workspace file "old/a.txt" containing "a"
    And the computer disk holds workspace file "old/b.txt" containing "b"
    And the computer disk holds an empty folder "keep"
    And the computer disk is published
    And no owner is running
    And member "mia" renamed "/workspace/old/a.txt" to "/workspace/keep/a.txt" while the computer was off
    When the organization owner "ryan" deletes the computer folder "/workspace/old" recursively if it still has the tree hash it was shown
    Then the file response status is 409
    And the file response error is "path_busy"
    And the overlay holds one entry

  @server
  Scenario: A recursive delete drops the pending changes inside the folder
    Given the computer disk holds workspace file "old/a.txt" containing "a"
    And the computer disk is published
    And no owner is running
    And member "mia" created "/workspace/old/new.txt" with "n" while the computer was off
    When the organization owner "ryan" deletes the computer folder "/workspace/old" recursively if it still has the tree hash it was shown
    Then the file response status is 200
    And the overlay holds one delete of the folder "/workspace/old" with the tree hash of the saved copy
    And the edit overlay holds no entry for "/workspace/old/new.txt"

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
    When a member reads the computer file "/workspace/a.txt"
    Then the content response holds "a"
    And the audit log has a record for member "ryan" with these fields:
      | field     | value               |
      | operation | discard             |
      | path      | /workspace/a.txt    |

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
      | action                |
      | creates the folder    |
      | deletes the path      |
      | renames the path from |
      | renames the path to   |

  @server
  Scenario: A link in the saved copy is deleted as a link and its target is untouched
    Given the computer disk holds workspace file "real.txt" containing "one"
    And the computer disk holds workspace link "alias.txt" pointing to "real.txt"
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
    When member "mia" deletes the computer path "/workspace/app/node_modules" if it still has the hash of "nothing"
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
  Scenario: An owner of protocol 1 blocks deletes, renames and new folders while it runs
    Given the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk is published
    And a live owner is polling for the household computer with protocol version 1
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "a"
    Then the file response status is 409
    And the file response error is "owner_too_old"
    When member "mia" creates the computer folder "/workspace/docs"
    Then the file response status is 409
    And the file response error is "owner_too_old"

  @server
  Scenario: A computer in a customer account cannot be changed
    Given the organization is homed in the account "111122223333" with no cross-account role
    When member "mia" creates the computer folder "/workspace/docs"
    Then the file response status is 409
    And the file response error is "edit_unsupported"

  @server
  Scenario: A delete, a rename and a new folder wait while the owner seals the overlay
    Given the computer disk is published
    And an owner of the household computer is hydrating
    And the owner sealed the overlay
    When member "mia" creates the computer folder "/workspace/docs"
    Then the file response status is 503
    And the file response error is "computer_starting"
    And the audit log has no records

  @server
  Scenario: A member who deletes too often is told to wait
    Given the computer disk is published
    And no owner is running
    When member "mia" makes 31 delete requests within one minute
    Then the 31st file response status is 429
    And the 31st file response carries a "Retry-After" header

  # ---------------------------------------------------------------- audit

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
      | operation | path             | to_path          | outcome | source  | sha256_before   |
      | delete    | /workspace/a.txt |                  | ok      | overlay | the hash of "a" |
      | move      | /workspace/b.txt | /workspace/c.txt | ok      | overlay | the hash of "b" |
      | mkdir     | /workspace/docs  |                  | ok      | overlay |                 |
    And the audit record holds no file content

  # ---------------------------------------------------------------- through the running computer

  @server
  Scenario: A running computer deletes, renames and creates folders through the owner
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "a.txt" containing "a"
    And the live disk of the owner holds workspace file "b.txt" containing "b"
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "a"
    And the owner answers every file request until the change is answered
    Then the file response status is 200
    And the file response says "source" is "live"
    And the file response says "backed_up" is "false"
    When member "mia" renames the computer file "/workspace/b.txt" to "/workspace/c.txt" if it still has the hash of "b"
    And the owner answers every file request until the change is answered
    Then the file response status is 200
    And the file response says "source" is "live"
    When member "mia" creates the computer folder "/workspace/docs"
    And the owner answers every file request until the change is answered
    Then the file response status is 200
    And the file response says "created" is "true"
    And the live disk of the owner has "c.txt"
    And the live disk of the owner has "docs"
    And the live disk of the owner has no "a.txt"
    And the live disk of the owner has no "b.txt"
    And the computer record says the disk is dirty
    And the edit overlay holds no entry for "/workspace/a.txt"

  @server
  Scenario: The owner deletes a whole folder for the organization owner role and renames one for a member
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "old/a.txt" containing "a"
    And the live disk of the owner holds workspace file "old/b.txt" containing "b"
    And the live disk of the owner holds workspace file "tidy/c.txt" containing "c"
    When the organization owner "ryan" deletes the computer folder "/workspace/old" recursively if it still has the tree hash it was shown
    And the owner answers every file request until the change is answered
    Then the file response status is 200
    And the file response says "removed" is "3"
    And the live disk of the owner has no "old"
    When member "mia" renames the computer folder "/workspace/tidy" to "/workspace/neat" if it still has the tree hash it was shown
    And the owner answers every file request until the change is answered
    Then the file response status is 200
    And the live disk of the owner has "neat/c.txt"
    And the live disk of the owner has no "tidy"

  @server
  Scenario: The tree hash of a folder comes from the owner when the computer runs
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "old/a.txt" containing "a"
    And the live disk of the owner holds workspace file "old/inner/c.txt" containing "ccc"
    When a member stats the computer folder "/workspace/old"
    And the owner polls and answers the file request it is given
    Then the file response says "source" is "live"
    And the file response carries the ETag of the tree hash of these entries:
      | kind | path        | value |
      | file | a.txt       | 1     |
      | dir  | inner       | 0     |
      | file | inner/c.txt | 3     |

  @server
  Scenario: A member cannot delete a folder with things in it through the owner either
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "old/a.txt" containing "a"
    When member "mia" deletes the computer folder "/workspace/old" recursively if it still has the hash of "anything"
    Then the file response status is 403
    And the file response error is "owner_role_required"
    And no file request was left for the owner
    And the audit log has a record for member "mia" with outcome "refused" and error "owner_role_required"
    And the live disk of the owner has "old/a.txt"

  @server
  Scenario: A delete of a file that changed on the computer is a precondition failure with the current hash
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "a.txt" containing "a changed by the bot"
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "a"
    And the owner answers every file request until the change is answered
    Then the file response status is 409
    And the file response error is "precondition_failed"
    And the file response says "current_sha256" is the hash of "a changed by the bot"
    And the live disk of the owner has "a.txt"
    And the audit log has a record for member "mia" with outcome "conflict"

  @server
  Scenario: A folder that is not empty cannot be deleted without recursion on the computer
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "old/a.txt" containing "a"
    When member "mia" deletes the computer folder "/workspace/old" without recursion if it still has the hash of "anything"
    And the owner answers every file request until the change is answered
    Then the file response status is 409
    And the file response error is "directory_not_empty"
    And the live disk of the owner has "old/a.txt"

  @server
  Scenario: A rename onto an existing path on the computer is refused by the owner
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "a.txt" containing "a"
    And the live disk of the owner holds workspace file "b.txt" containing "b"
    When member "mia" renames the computer file "/workspace/a.txt" to "/workspace/b.txt" if it still has the hash of "a"
    And the owner answers every file request until the change is answered
    Then the file response status is 409
    And the file response error is "already_exists"
    And the live disk of the owner now has workspace file "b.txt" containing "b"

  @server
  Scenario: A delete of a path that is not on the computer is not found
    Given a live owner is polling for the household computer
    When member "mia" deletes the computer file "/workspace/missing.txt" if it still has the hash of "a"
    And the owner answers every file request until the change is answered
    Then the file response status is 404
    And the file response error is "not_found"
    And the audit log has no records

  @server
  Scenario Outline: A delete, rename or new folder under .git is refused on the computer before the owner is asked
    Given a live owner is polling for the household computer
    When member "mia" <action> "/workspace/.git/hooks"
    Then the file response status is 403
    And the file response error is "path_refused"
    And no file request was left for the owner
    And the audit log has a record for member "mia" with outcome "refused" and error "path_refused"

    Examples:
      | action                |
      | creates the folder    |
      | deletes the path      |
      | renames the path from |
      | renames the path to   |

  @server
  Scenario: A delete the owner never takes does not happen later
    Given a live owner that polls every 10 seconds and last polled 9 seconds ago
    And the live disk of the owner holds workspace file "a.txt" containing "a"
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "a" and the owner does not answer for 8 seconds
    Then the file response status is 504
    And the file response error is "owner_timeout"
    And the live disk of the owner has "a.txt"

  @server
  Scenario: A delete the owner was asked for and never takes is abandoned and audited as failed
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "a.txt" containing "a"
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "a"
    And the owner answers the first file request and does not take the next for 8 seconds
    Then the file response status is 504
    And the file response error is "owner_timeout"
    And the audit log has a record for member "mia" with outcome "failed" and error "owner_timeout"
    When the owner polls
    Then the poll response carries no file request
    And the live disk of the owner has "a.txt"

  @server
  Scenario: A live delete, rename and new folder are audited with the hashes seen
    Given a live owner is polling for the household computer
    And the live disk of the owner holds workspace file "a.txt" containing "a"
    And the live disk of the owner holds workspace file "b.txt" containing "b"
    When member "mia" deletes the computer file "/workspace/a.txt" if it still has the hash of "a"
    And the owner answers every file request until the change is answered
    And member "mia" renames the computer file "/workspace/b.txt" to "/workspace/c.txt" if it still has the hash of "b"
    And the owner answers every file request until the change is answered
    And member "mia" creates the computer folder "/workspace/docs"
    And the owner answers every file request until the change is answered
    Then the audit log has these records for member "mia":
      | operation | path             | to_path          | outcome | source | sha256_before   |
      | delete    | /workspace/a.txt |                  | ok      | live   | the hash of "a" |
      | move      | /workspace/b.txt | /workspace/c.txt | ok      | live   | the hash of "b" |
      | mkdir     | /workspace/docs  |                  | ok      | live   |                 |
    And the audit record holds no file content
