Feature: Capability policy at live system sinks
  As a household member
  I want task grants enforced where the worker reads files
  So that a missing grant denies at the sink and at the HTTP front door, not only in kernel tests

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
    And turn "sink-turn" carries the capability grant

  Scenario: A live file sink denies an ungranted workspace path
    When the worker reads workspace file "/workspace/secrets/notes.txt" for tenant "anthus" turn "sink-turn"
    Then the gated workspace read is denied

  Scenario: A live file sink allows a granted workspace path
    When the worker reads workspace file "/workspace/research/notes.txt" for tenant "anthus" turn "sink-turn"
    Then the gated workspace read is allowed

  Scenario: A live file sink denies when no task grant is set on the turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When the worker reads workspace file "/workspace/research/notes.txt" for tenant "anthus" turn "ungranted-turn"
    Then the gated workspace read is denied

  Scenario: The HTTP front door denies granting a missing turn
    Given an empty control plane backed by a durable messaging store with HTTP
    When user "ryan" of tenant "anthus" PUTs a turn grant over HTTP for turn "missing-turn":
      | field | value          |
      | tools | read_workspace |
    Then the turn grant HTTP response has status 403
