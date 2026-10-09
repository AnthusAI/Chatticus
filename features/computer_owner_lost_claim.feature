Feature: An owner that loses the turn leaves the computer alone
  As the operator of an organization computer
  I want an owner whose claim on the turn loses to leave the computer record and its snapshot untouched
  So that a second owner started by a slow boot never stops the computer under the owner that won or publishes a stale disk over its work

  Two owners can run for one turn when a start takes longer than the host
  start lease: the probe publishes another start job, the starter claims a new
  generation and launches another owner. The turn claim lets exactly one of
  them run. The one that loses has hydrated its own copy of the disk, which
  is the published snapshot and nothing the winner has written, so it must not
  publish that copy and must not mark the computer stopped while the winner is
  still running on it.

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
    And the organization's computer is running
    And the disk was published 0 times
    And the turn has one computer action and it is not done
    And the model was asked 1 time
    When held computer owner "winner" is released
    Then the takeover of "winner" ended "done"
    And the turn is completed
    And the computer action was claimed by "computer-owner-winner"
    And the turn took exactly 2 attempts
    And the workspace file "notes.md" contains "draft-one"
