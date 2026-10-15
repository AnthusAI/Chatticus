Feature: The supervisor carries out file requests for the live computer through the unprivileged file helper
  As a member of an organization
  I want the running computer to list, read, write, delete, rename and create files when the control plane asks
  So that I see and change what is on the disk now, and the owner that holds the cloud credentials never opens a path I named

  The control plane leaves file requests in the answer to the supervisor's poll. The supervisor runs each one through the file
  helper, which is started through the same unprivileged launcher that starts the model's commands, validates the answer
  against the protocol and posts it. It never opens a workspace path itself, so a link planted in the workspace can lead a
  request only where the shell could already go, and the helper additionally refuses a final location outside the workspace
  and any path inside a .git directory. At most two helpers run at a time, a request that cannot start in time is answered
  without touching the disk, and a helper that hangs is killed at its timeout. The sweep that kills the shell user's
  processes after a turn and the stop sequence wait for the operation in flight. A write is activity, and it schedules the
  quiet publish. The wire schemas are in host-protocol/src/live-files.ts and the contract is docs/LIVE_FILES_PROTOCOL.md.

  Background:
    Given a supervisor whose task environment holds a bootstrap token

  # ---------------------------------------------------------------- the helper and its containment

  Scenario: The helper lists a directory with kinds, sizes and link targets
    Given the workspace holds a file "a.txt" of 3 bytes, a directory "src" and a symbolic link "latest" to "a.txt"
    When the supervisor is given a list request for "/workspace"
    Then the result lists these entries in order:
      | name   | kind      | size | link_target |
      | src    | directory |      |             |
      | a.txt  | file      | 3    |             |
      | latest | symlink   |      | a.txt       |

  Scenario: A planted link to a file outside the workspace is not read
    Given a file "owner-only.txt" outside the workspace containing "owner-secret-value"
    And the workspace has a symbolic link "leak" to the outside file "owner-only.txt"
    When the supervisor is given a read request for "/workspace/leak"
    Then the result is the error "outside_workspace"
    And the result does not contain "owner-secret-value"

  Scenario: A planted link to a file outside the workspace is not overwritten
    Given a file "owner-only.txt" outside the workspace containing "owner-secret-value"
    And the workspace has a symbolic link "leak" to the outside file "owner-only.txt"
    When the supervisor is given a write request for "/workspace/leak" with "overwritten" and the hash of "owner-secret-value"
    Then the result is the error "outside_workspace"
    And the outside file "owner-only.txt" still contains "owner-secret-value"

  Scenario: A link inside the workspace is written through and stays a link
    Given the workspace has a file "real.txt" containing "one"
    And the workspace has a symbolic link "alias.txt" to "real.txt"
    When the supervisor is given a write request for "/workspace/alias.txt" with "two" and the hash of "one"
    Then the result is ok
    And the workspace file "real.txt" contains "two"
    And "alias.txt" is still a symbolic link to "real.txt"

  Scenario: A link inside the workspace to a .git file is refused by the helper as well
    Given the workspace has a file ".git/config" containing "[core]"
    And the workspace has a symbolic link "sneaky" to ".git/config"
    When the supervisor is given a create request for "/workspace/sneaky" with "[core] changed"
    Then the result is the error "path_refused"
    And the workspace file ".git/config" contains "[core]"

  Scenario: A pipe in the workspace does not hang a read
    Given the workspace holds a named pipe "fifo"
    When the supervisor is given a read request for "/workspace/fifo"
    Then the result is the error "not_a_file" within 2 seconds

  Scenario: A helper that hangs is killed at its timeout
    Given the file helper never answers
    When the supervisor is given a read request for "/workspace/notes.md"
    And 7 seconds go by
    Then the result is the error "helper_timeout"
    And no helper process is left running

  # ---------------------------------------------------------------- the runner

  Scenario: A request that waited too long in the supervisor is answered expired without touching the disk
    Given the file helper takes 5 seconds for each operation
    And two file operations are running
    When the supervisor is given a create request for "/workspace/late.txt" with "late" that expires in 2 seconds
    And 6 seconds go by
    Then the result is the error "expired"
    And the workspace has no file "late.txt"

  Scenario: A file operation in flight is not killed by the sweep after a turn
    Given the file helper takes 2 seconds for each operation
    And the supervisor is serving a turn
    And a file operation is running
    When the turn's child exits
    Then the sweep of the shell user's processes has not run yet
    When 3 seconds go by
    Then the file operation finishes with its own result
    And the sweep ran after it finished

  Scenario: A stopping supervisor finishes the operation in flight and refuses the rest
    Given the file helper takes 3 seconds for each operation
    And an idle supervisor
    And a write operation is running
    And another file operation is running
    And a third file request is waiting
    When the supervisor begins to stop
    And 4 seconds go by
    Then the write finishes and its result is posted
    And the waiting request is answered "owner_stopping"
    And the final publish includes the written file

  Scenario: An edit schedules a quiet publish and counts as activity
    Given the file helper takes no time
    And the supervisor is idle with its idle clock at 10 minutes
    When a write request is answered ok
    Then the idle clock starts again
    And a publish is due in 30 seconds

  Scenario: The file operation line carries no path and no content
    Given the workspace has a file "secret-plans.md" containing "launch-codes-alpha"
    When the supervisor answers a read of "/workspace/secret-plans.md"
    Then the log line "file_operation" has the fields "kind", "bytes", "path_hash", "outcome" and "duration_ms"
    And no log line contains "secret-plans"
    And no log line contains "launch-codes-alpha"

  Scenario: An owner that is told it is no longer the owner stops when it posts a result
    Given the file helper takes 1 seconds for each operation
    And the control plane will answer the next file result with 403 "not_current_owner"
    When the supervisor is given a read request for "/workspace/notes.md"
    And 2 seconds go by
    Then the supervisor ends as superseded

  # ---------------------------------------------------------------- delete, rename and new folders

  Scenario: The helper deletes a link and not its target
    Given the workspace has a file "real.txt" containing "one"
    And the workspace has a symbolic link "alias.txt" to "real.txt"
    When the supervisor is given a delete request for "/workspace/alias.txt" with the symlink hash
    Then the result is ok
    And the workspace file "real.txt" contains "one"
    And "alias.txt" does not exist

  Scenario: The helper refuses a rename that would leave the workspace
    Given the workspace has a file "a.txt" containing "a"
    And the workspace has a symbolic link "out" to the outside directory
    When the supervisor is given a move request from "/workspace/a.txt" to "/workspace/out/a.txt" with the hash of "a"
    Then the result is the error "outside_workspace"
    And the workspace file "a.txt" contains "a"

  Scenario: The helper removes a folder tree only when its tree hash is the one seen
    Given the workspace has a file "tree/a.txt" containing "a"
    And the workspace has a file "tree/sub/b.txt" containing "b"
    When the supervisor is given a recursive delete request for "/workspace/tree" with another tree hash
    Then the result is the error "precondition_failed" with the current tree hash
    And the workspace still holds "tree/sub/b.txt"
    When the supervisor is given a recursive delete request for "/workspace/tree" with the current tree hash
    Then the result is ok with 4 entries removed
    And "tree" does not exist

  Scenario: The helper renames without replacing
    Given the workspace has a file "a.txt" containing "a"
    And the workspace has a file "b.txt" containing "b"
    When the supervisor is given a move request from "/workspace/a.txt" to "/workspace/b.txt" with the hash of "a"
    Then the result is the error "already_exists"
    And the workspace file "b.txt" contains "b"

  Scenario: The helper judges a folder by its tree hash in the one field that judges a file by its content hash
    Given the workspace holds an empty folder "hollow"
    And the workspace has a file "tidy/b.txt" containing "b"
    And the workspace has a file "keep.txt" containing "k"
    When the supervisor is given a delete request for "/workspace/hollow" with the hash a person would be shown
    Then the result is ok
    And "hollow" does not exist
    When the supervisor is given a move request from "/workspace/tidy" to "/workspace/neat" with the hash a person would be shown
    Then the result is ok
    And the workspace file "neat/b.txt" contains "b"
    And "tidy" does not exist
    When the supervisor is given a delete request for "/workspace/keep.txt" with the hash a person would be shown
    Then the result is ok
    And "keep.txt" does not exist

  Scenario: A folder with another hash than the one seen is not renamed
    Given the workspace has a file "tidy/b.txt" containing "b"
    When the supervisor is given a move request from "/workspace/tidy" to "/workspace/neat" with the hash of "not the folder"
    Then the result is the error "precondition_failed"
    And the workspace still holds "tidy/b.txt"

  Scenario: The helper's stat gives the content hash of a file when asked
    Given the workspace has a file "a.txt" containing "hello"
    When the supervisor is given a stat request for "/workspace/a.txt" that asks for the hash
    Then the result is the stat of a file with the content hash of "hello"

  Scenario: The helper does not hash a file over the read limit
    Given the workspace has a file "big.txt" of 8388609 bytes
    When the supervisor is given a stat request for "/workspace/big.txt" that asks for the hash
    Then the result is the error "file_too_large"
    When the supervisor is given a stat request for "/workspace/big.txt" that does not ask for the hash
    Then the result is the stat of a file without a content hash
