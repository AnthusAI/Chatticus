Feature: Thin task HTTP and worker wiring
  As a household member
  I want the task tool reachable from ThinTurn HTTP and the computerless worker
  So that bots can manage durable tasks without a computer and tenants stay isolated

  Background:
    Given an empty control plane

  Scenario: ThinTurn HTTP invokes the task tool for a bot
    Given tenant "anthus" user "ryan" has a bot named "Assistant"
    When tenant "anthus" posts the task tool create action for bot "Assistant" with title "Pay the electric bill"
    Then the HTTP task response has status "open"
    And the HTTP task response records bot "Assistant" as provenance

  Scenario: Another tenant cannot invoke the task tool for a bot
    Given tenant "anthus" user "ryan" has a bot named "Assistant"
    When tenant "other-household" posts the task tool create action for bot "Assistant" with title "sneaky task"
    Then the HTTP task tool call is denied for tenant isolation

  Scenario: A user's tasks can be listed over HTTP with tenant isolation
    Given tenant "anthus" user "ryan" has a bot named "Assistant"
    When tenant "anthus" posts the task tool create action for bot "Assistant" with title "Pay the electric bill"
    Then tenant "anthus" can list tasks for user "ryan":
      | 1 |
    And another tenant cannot list tasks for user "ryan"

  Scenario: A stored task can be read over HTTP with tenant isolation
    Given tenant "anthus" user "ryan" has a bot named "Assistant"
    When tenant "anthus" posts the task tool create action for bot "Assistant" with title "Pay the electric bill"
    Then tenant "anthus" can read the HTTP task by identifier
    And another tenant cannot read the HTTP task by identifier

  Scenario: A computerless worker creates a task through the model tool list
    Given tenant "anthus" user "ryan" has a bot named "Assistant"
    And the household computer is stopped for task work
    When bot "Assistant" receives "please create a task titled Pay the electric bill"
    And bot "Assistant" runs one task-aware computerless worker turn
    Then the task is stored with status "open"
    And no computer was summoned for the task tool
