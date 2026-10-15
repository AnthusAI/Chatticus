Feature: Per-task run_terminal via human grant replace
  As an enabled organization member
  I want to replace the default grant of one turn with a different one
  So the replacement, not the default, decides whether that turn can run_terminal

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP

  Scenario: A replaced grant that includes run_terminal is allowed by policy
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And the household computer is stopped
    When a human asks the bot to run command "ls /workspace" using cwd "/workspace"
    And user "ryan" of tenant "anthus" replaces the active turn grant with:
      | field          | value                         |
      | tools          | read_workspace, run_terminal  |
      | origins        |                               |
      | recipients     |                               |
      | file_scopes    | /workspace                    |
      | egress_classes | approved_origin_fetch         |
    Then the turn grant HTTP response has status 200
    And the active turn grant is exactly that table
    When bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn is not denied for lack of run_terminal on the grant
    And a computer continuation job is queued for the turn
    And the turn is waiting on the workspace capability

  Scenario: A replaced grant that leaves out run_terminal denies it
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And the household computer is stopped
    When a human asks the bot to run command "ls /workspace" using cwd "/workspace"
    And user "ryan" of tenant "anthus" replaces the active turn grant with:
      | field          | value                         |
      | tools          | read_workspace                |
      | origins        |                               |
      | recipients     |                               |
      | file_scopes    | /workspace                    |
      | egress_classes | approved_origin_fetch         |
    Then the turn grant HTTP response has status 200
    When bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn journal records a denied run_terminal tool result
    And no computer continuation job is queued for the turn
    And the turn is not waiting on the workspace capability
