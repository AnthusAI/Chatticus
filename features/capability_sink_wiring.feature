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
    Given the household computer workspace file "/workspace/research/notes.txt" contains "weekly"
    When the worker reads workspace file "/workspace/research/notes.txt" for tenant "anthus" turn "sink-turn"
    Then the gated workspace read returns "weekly"

  Scenario: A live file sink denies when no task grant is set on the turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And the household computer workspace file "/workspace/research/notes.txt" contains "weekly"
    When the worker reads workspace file "/workspace/research/notes.txt" for tenant "anthus" turn "ungranted-turn"
    Then the gated workspace read is denied

  Scenario: The HTTP front door allows a granted workspace read
    Given an empty control plane
    And a worker registered over HTTP as:
      | worker_id    | test-worker |
      | tenant_id    | anthus      |
      | cost_class   | local       |
      | capabilities | cpu         |
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    And the household computer workspace file "/workspace/research/notes.txt" contains "weekly"
    When user "ryan" of tenant "anthus" posts a fence probe addressed to bot "Researcher" without enqueueing a turn job
    And the registered worker puts a turn grant for the active turn over HTTP:
      | field          | value                    |
      | tools          | browse, read_workspace   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace/research      |
      | egress_classes | approved_origin_fetch    |
    Then the turn grant HTTP response has status 200
    When the registered worker posts turn workspace read over HTTP for user "ryan" path "/workspace/research/notes.txt"
    Then the workspace read HTTP response has status 200
    And the workspace read HTTP content equals "weekly"

  Scenario: The HTTP front door denies workspace read without a grant
    Given an empty control plane
    And a worker registered over HTTP as:
      | worker_id    | test-worker |
      | tenant_id    | anthus      |
      | cost_class   | local       |
      | capabilities | cpu         |
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    When user "ryan" of tenant "anthus" posts a fence probe addressed to bot "Researcher" without enqueueing a turn job
    And the registered worker posts turn workspace read over HTTP for user "ryan" path "/workspace/research/notes.txt"
    Then the workspace read HTTP response has status 403

  Scenario: The HTTP front door denies granting a missing turn
    Given an empty control plane
    And a worker registered over HTTP as:
      | worker_id    | test-worker |
      | tenant_id    | anthus      |
      | cost_class   | local       |
      | capabilities | cpu         |
    When the registered worker puts a turn grant over HTTP for turn "missing-turn":
      | field | value          |
      | tools | read_workspace |
    Then the turn grant HTTP response has status 403
