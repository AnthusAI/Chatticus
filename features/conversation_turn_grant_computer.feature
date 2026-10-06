Feature: Conversation task grant reaches the computer for granted workspace paths
  As an enabled organization member
  I want the household conversation grant to let a bot read and write its workspace
  So that a newly created bot can work on the computer without a second authorization

  Background:
    Given an empty control plane

  Scenario: The conversation grant allows read_workspace under /workspace
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And the household computer is stopped
    When bot "Researcher" is asked "read workspace file /workspace/research/notes.txt"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then a computer continuation job is queued for the turn
    And the turn is waiting on the workspace capability

  Scenario: The conversation grant allows write_workspace under /workspace
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And the household computer is stopped
    When bot "Researcher" is asked "write workspace file /workspace/research/notes.txt containing draft-content"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then a computer continuation job is queued for the turn
    And the turn is waiting on the workspace capability

  Scenario: The conversation grant does not reach a path outside /workspace
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And the household computer is stopped
    When bot "Researcher" is asked "read workspace file /etc/passwd"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn journal records a denied read_workspace tool result
    And no computer start job is queued
    And the household computer is stopped
