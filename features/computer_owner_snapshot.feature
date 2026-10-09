Feature: The container owner keeps the computer's disk
  As the operator of an organization computer
  I want the container owner to restore the computer's workspace before the turn and save it afterwards
  So that the bot works on the same files the host worker would have served, and the computer is recorded as stopped when the owner is gone

  The owner reuses the host worker's disk lifecycle. It marks the computer
  running, hydrates the workspace from the computer's published snapshot,
  runs the turn, publishes the disk when it is dirty and marks the computer
  stopped. The disk is persisted once, whether the turn ends, crashes, or the
  container is told to stop first. An owner that could not restore the disk
  publishes nothing, because an empty disk would replace the saved one.

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

  Scenario: The owner restores the published workspace before the turn reads it
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
    And the computer was running while the owner's turn ran
    And the model saw "first draft" in its next request

  Scenario: The owner publishes the workspace it changed so the next host finds it
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "second draft"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    And the owner "owner-1" runs the parked turn on its computer disk
    Then the owner's turn ended "done"
    And the snapshot store has a pack for tenant "anthus" computer "household-computer"
    And tenant "anthus" computer "household-computer" is not dirty on the store
    When the customer computer host "garage-mac-1" boots through the Front Door worker plane
    Then host "garage-mac-1" has workspace file "notes.md" containing "second draft"

  Scenario: The computer is recorded as stopped when the owner exits cleanly
    Given the model is scripted to answer "Hello."
    When the member asks "say hello"
    And a Lambda-style owner works the turn to its end
    And the owner "owner-1" runs the parked turn on its computer disk
    Then the computer was running while the owner's turn ran
    And the organization's computer is stopped

  Scenario: A turn that crashes still saves the disk and stops the computer
    When the owner "owner-1" runs a turn that writes "partial.md" containing "half done" and then crashes
    Then the owner's run failed with "the turn crashed"
    And the organization's computer is stopped
    And the disk was published 1 time
    When the customer computer host "garage-mac-1" boots through the Front Door worker plane
    Then host "garage-mac-1" has workspace file "partial.md" containing "half done"

  Scenario: An owner told to stop mid-turn saves the disk once
    When the owner "owner-1" is told to stop while its turn has written "partial.md" containing "half done"
    Then the organization's computer is stopped
    And the disk was published 1 time
    When the customer computer host "garage-mac-1" boots through the Front Door worker plane
    Then host "garage-mac-1" has workspace file "partial.md" containing "half done"

  Scenario: An owner that could not restore the disk publishes nothing and runs no turn
    Given worker "garage-mac-1" has published computer "household-computer" with workspace file "notes.md" containing "first draft"
    When the owner "owner-1" runs a turn while the snapshot downloads fail
    Then the owner's run failed with "the download failed"
    And the disk was published 0 times
