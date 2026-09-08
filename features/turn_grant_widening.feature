Feature: Enabled member replaces an active turn grant
  As an enabled organization member
  I want to replace the active turn's closed grant
  So the bot may use tools I explicitly authorize for this task only

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP

  Scenario: An enabled member replaces the conversation grant on an active turn
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And user "ryan" of tenant "anthus" has started a turn with the household conversation grant
    When user "ryan" of tenant "anthus" replaces the active turn grant with:
      | field          | value                    |
      | tools          | read_workspace, browse   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace               |
      | egress_classes | approved_origin_fetch    |
    Then the turn grant HTTP response has status 200
    And the active turn grant is exactly that table
    And the turn journal records a grant replacement by user "ryan"

  Scenario: A grant that exceeds the member's recorded standing is refused
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And user "ryan" of tenant "anthus" has a grant standing ceiling of:
      | field       | value          |
      | tools       | read_workspace |
      | file_scopes | /workspace     |
    And user "ryan" of tenant "anthus" has started a turn with the household conversation grant
    When user "ryan" of tenant "anthus" replaces the active turn grant with tools beyond that standing
    Then the turn grant HTTP response has status 403
    And the active turn still carries the household conversation grant
    And the turn journal does not record a grant replacement

  Scenario: A member cannot replace a turn grant with owner-only consequential tools
    Given tenant "anthus" user "sam" is an enabled member
    And tenant "anthus" user "sam" has a bot named "Researcher"
    And user "sam" of tenant "anthus" has started a turn with the household conversation grant
    When user "sam" of tenant "anthus" replaces the active turn grant with:
      | field          | value    |
      | tools          | purchase |
      | recipients     |          |
      | file_scopes    |          |
      | egress_classes |          |
    Then the turn grant HTTP response has status 403
    And the active turn still carries the household conversation grant

  Scenario: An unauthenticated caller cannot replace a turn grant
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And user "ryan" of tenant "anthus" has started a turn with the household conversation grant
    When an unauthenticated caller PUTs the active turn grant on the user route
    Then the turn grant HTTP response has status 403
    And the active turn still carries the household conversation grant

  Scenario: A worker bearer cannot replace a turn grant on the user route
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And a worker registered over HTTP as:
      | worker_id    | grant-worker |
      | tenant_id    | anthus       |
      | cost_class   | local        |
      | capabilities | cpu          |
    And user "ryan" of tenant "anthus" has started a turn with the household conversation grant
    When the registered worker puts a turn grant for the active turn over HTTP:
      | field | value          |
      | tools | read_workspace |
    Then the turn grant HTTP response has status 403
    And the active turn still carries the household conversation grant

  Scenario: Replacing the grant does not union with the conversation preset
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And user "ryan" of tenant "anthus" has started a turn with the household conversation grant
    When user "ryan" of tenant "anthus" replaces the active turn grant with:
      | field          | value                    |
      | tools          | browse                   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace/docs          |
      | egress_classes | approved_origin_fetch    |
    Then the turn grant HTTP response has status 200
    And the active turn grant is exactly that table
    And the active turn grant does not include tool "write_workspace"
    And the active turn grant does not include tool "read_workspace"

  Scenario: A member-replaced grant survives a Front Door recycle
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And user "ryan" of tenant "anthus" has started a turn with the household conversation grant
    When user "ryan" of tenant "anthus" replaces the active turn grant with:
      | field          | value                    |
      | tools          | browse, read_workspace   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace/research      |
      | egress_classes | approved_origin_fetch    |
    And a recycled Front Door serves the same messaging store
    Then the active turn grant is exactly that table
