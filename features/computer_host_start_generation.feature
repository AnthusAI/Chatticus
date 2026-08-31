Feature: Household computer host start generation on HTTP
  As a household member
  I want GET /users/{user_id}/computer to expose host_start_generation
  So that callers see zero before any host start is recorded

  Scenario: GET computer reports host_start_generation zero on a fresh household
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" household computer is stopped
    Then tenant "anthus" can read the household computer for user "ryan"
    And tenant "anthus" household computer for user "ryan" reports host_start_generation 0

  Scenario: GET computer still reports host_start_generation zero after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" household computer is stopped
    When a recycled Front Door serves the same messaging store
    Then tenant "anthus" can read the household computer for user "ryan"
    And tenant "anthus" household computer for user "ryan" reports host_start_generation 0

  Scenario: GET computer reports host_start_generation after a computer-queue nack
    Given an empty control plane backed by a durable messaging store with HTTP
    And a fenced computer handoff with a queued continuation job
    When a computer-capable pull worker without a host executor pulls that continuation job
    Then tenant "anthus" household computer for user "ryan" reports host_start_generation 1

  Scenario: GET computer sees a host start recorded by another worker process
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" household computer is stopped
    Then tenant "anthus" can read the household computer for user "ryan"
    When a second process sharing the store records a host start for tenant "anthus" user "ryan"
    Then tenant "anthus" household computer for user "ryan" reports host_start_generation 1

  Scenario: GET computer sees a nack host start from a second process
    Given an empty control plane backed by a durable messaging store with HTTP
    And a fenced computer handoff with a queued continuation job
    When a second process sharing the store nacks that continuation without a host
    Then tenant "anthus" household computer for user "ryan" reports host_start_generation 1
