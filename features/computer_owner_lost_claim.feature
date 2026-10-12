Feature: An owner that loses the turn leaves the turn alone
  As the operator of an organization computer
  I want an owner whose claim on the turn loses to change nothing about the turn
  So that two owners reaching for one turn never run its tools twice

  Two owners can reach for one turn when a start takes longer than the host
  start lease: the probe publishes another start job and the starter launches
  another owner. The turn claim lets exactly one of them run. The one that loses
  asks the model nothing and runs no tool. A supervisor that has been replaced is
  kept from stopping the computer or publishing over the newer owner's disk by the
  control plane, which refuses its routes for the generation it no longer holds
  (features/computer_owner_long_lived.feature); the claim race is about the turn.

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

  Scenario: The owner that loses the claim changes nothing and the winner finishes the turn
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
    And the turn has one computer action and it is not done
    And the model was asked 1 time
    When held computer owner "winner" is released
    Then the takeover of "winner" ended "done"
    And the turn is completed
    And the computer action was claimed by "computer-owner-winner"
    And the turn took exactly 2 attempts
    And the workspace file "notes.md" contains "draft-one"
