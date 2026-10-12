Feature: The container owner reports where a turn is
  As the operator of an organization computer
  I want the owner to write one structured line for each step of a takeover
  So that a real-work turn that fails or stalls can be diagnosed from the owner's log group

  The supervisor writes the lines of the container's life (started, hydrated,
  dispatched, child exited, stopping, published) and the per-turn child writes
  the lines of its turn. Every line names the event and carries the tenant and
  the owner id; the lines about a turn carry the turn id too. The owner id is
  not a secret. The lines never carry the gateway token, the
  scoped credentials, the invoke key, a tool's arguments or a tool's output;
  a tool is named, with how it ended and how long it took.

  Background:
    Given an empty control plane
    And a filesystem snapshot store bound to the host worker
    And tenant "anthus" user "ryan" has computer "household-computer"
    And a worker registered as:
      | worker_id    | garage-mac-1       |
      | tenant_id    | anthus             |
      | cost_class   | local              |
      | capabilities | computer,browser   |
      | computer_id  | household-computer |
    And the computer owner has an empty workspace directory

  @owner-log
  Scenario: An owner that runs a tool and changes the workspace reports each step in order
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "confidential-draft-text"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    And the owner "owner-1" runs the parked turn on its computer disk
    Then the owner's turn ended "done"
    And the owner log of "owner-1" shows these events in order:
      | owner_started           |
      | workspace_hydrated      |
      | owner_dispatch_received |
      | owner_serving_turn      |
      | turn_claimed            |
      | tool_started            |
      | tool_finished           |
      | owner_exit              |
      | owner_child_exited      |
      | owner_stopping          |
      | snapshot_published      |
    And every owner log line of "owner-1" names the tenant "anthus" and the owner id, and the lines about a turn name it
    And the owner log line "workspace_hydrated" of "owner-1" has "generation" "none"
    And the owner log line "tool_finished" of "owner-1" has "tool" "write_workspace"
    And the owner log line "tool_finished" of "owner-1" has "status" "ok"
    And the owner log line "tool_finished" of "owner-1" has a "duration_ms" number
    And the owner log line "snapshot_published" of "owner-1" has "generation" "1"
    And the owner log line "owner_exit" of "owner-1" has "code" "0"
    And the owner log line "owner_exit" of "owner-1" has "outcome" "done"
    And the owner log of "owner-1" does not contain "confidential-draft-text"

  @owner-log
  Scenario: An owner that restores a published workspace and changes nothing skips the publish and says why
    Given worker "garage-mac-1" has published computer "household-computer" with workspace file "notes.md" containing "first draft"
    And the model is scripted to call "read_workspace" with:
      """
      {"path": "/workspace/notes.md"}
      """
    And the model is scripted to answer "I read the notes."
    When the member asks "what do the notes say"
    And a Lambda-style owner works the turn until it parks
    And the owner "owner-1" runs the parked turn on its computer disk
    Then the owner's turn ended "done"
    And the owner log line "workspace_hydrated" of "owner-1" has "generation" "1"
    And the owner log line "snapshot_skipped" of "owner-1" has "reason" "unchanged"
    And the owner log of "owner-1" has no "snapshot_published" line
    And the owner log of "owner-1" does not contain "first draft"

  @owner-log
  Scenario: A tool that fails is reported as an error without its output
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo secret-terminal-output; exit 3"}
      """
    And the model is scripted to answer "That failed."
    When the member asks "run the script"
    And a Lambda-style owner works the turn until it parks
    And the owner "owner-1" runs the parked turn on its computer disk
    Then the owner log line "tool_finished" of "owner-1" has "tool" "run_terminal"
    And the owner log line "tool_finished" of "owner-1" has "status" "error"
    And the owner log of "owner-1" does not contain "secret-terminal-output"
    And the owner log of "owner-1" does not contain "exit 3"

  @owner-log
  Scenario: The owner that loses the claim says so and publishes nothing
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "draft-one"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    And computer owner "winner" takes over the turn and is held after its tool ran
    And the owner "loser" runs the parked turn on its computer disk
    Then the owner's turn ended "lost"
    And the owner log of "loser" shows these events in order:
      | owner_started      |
      | workspace_hydrated |
      | turn_claim_lost    |
      | owner_exit         |
      | owner_child_exited |
    And the owner log line "owner_exit" of "loser" has "code" "1"
    And the owner log line "owner_exit" of "loser" has "outcome" "lost"
    And the owner log line "owner_child_exited" of "loser" has "code" "1"
    And the owner log line "owner_child_exited" of "loser" has "consecutive_failures" "0"
    And the owner log of "loser" has no "turn_claimed" line
    When held computer owner "winner" is released
    Then the takeover of "winner" ended "done"

  @owner-log
  Scenario: An owner that could not restore the disk reports the failed boot and the error name
    Given worker "garage-mac-1" has published computer "household-computer" with workspace file "notes.md" containing "first draft"
    When the owner "owner-1" runs a turn while the snapshot downloads fail
    Then the owner stopped with exit code 8
    And the owner log of "owner-1" shows these events in order:
      | owner_started           |
      | workspace_hydrate_failed |
      | snapshot_skipped        |
    And the owner log line "snapshot_skipped" of "owner-1" has "reason" "boot_failed"
    And the owner log line "snapshot_skipped" of "owner-1" has "error_name" "Error"
    And the owner log of "owner-1" has no "snapshot_published" line
    And the owner log of "owner-1" does not contain "the download failed"
