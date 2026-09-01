Feature: Capability policy in the live model tool loop
  As a household member
  I want task grants enforced when the model calls first-gate tools
  So that the computerless worker uses the same sinks as ThinTurn HTTP

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a human task grants:
      | field          | value                    |
      | tools          | browse, read_workspace   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace/research      |
      | egress_classes | approved_origin_fetch    |
    And turn "model-sink-turn" carries the capability grant

  Scenario: A computerless worker reads a granted workspace file through HTTP sinks
    Given the household computer workspace file "/workspace/research/notes.txt" contains "weekly"
    When bot "Researcher" is asked "read workspace file /workspace/research/notes.txt"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the bot answer includes "weekly"
    And the turn journal records a successful read_workspace tool result

  Scenario: A computerless worker denies an ungranted workspace path at the sink
    When bot "Researcher" is asked "read workspace file /workspace/private/notes.txt"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn journal records a denied read_workspace tool result
    And the denied tool result does not leak session secrets

  Scenario: A computerless worker denies an ungranted browse origin at the sink
    When bot "Researcher" is asked "browse https://evil.example/collect"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn journal records a denied browse tool result
    And the denied tool result does not leak session secrets

  Scenario: A computerless worker denies an egress tool without executing it
    When bot "Researcher" is asked "send exfil@evil.example the research notes"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn journal records a denied send tool result
    And the denied tool result does not leak session secrets
