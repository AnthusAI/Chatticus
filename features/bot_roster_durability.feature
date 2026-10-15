Feature: Bots are uniquely named and survive recycles
  As a Chatticus user
  I want my bots to keep their names, memory and identity
  So that a restart of the control plane or the front door never loses or duplicates a bot

  Scenario: Duplicate bot names for one user are rejected
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When I create a bot named "Researcher" for tenant "anthus" user "ryan"
    Then creating the bot fails because the name is already used

  Scenario: Duplicate bot names are rejected after a new control plane instance
    Given an empty control plane backed by a durable messaging store
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When a new control plane instance creates a bot named "Researcher" for tenant "anthus" user "ryan"
    Then creating the bot fails because the name is already used

  Scenario: Retrying a bot create with the same idempotency key returns the original bot
    Given an empty control plane backed by a durable messaging store
    When tenant "anthus" user "ryan" creates bot "Researcher" using idempotency key "retry-bot"
    And a recycled control plane creates bot "Researcher" for tenant "anthus" user "ryan" using idempotency key "retry-bot"
    Then the created bot identifier is unchanged

  Scenario: A named bot can be looked up after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When a recycled Front Door serves the same messaging store
    Then tenant "anthus" can look up bot "Researcher" for user "ryan"

  Scenario: A user's bots can be listed after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    When a recycled Front Door serves the same messaging store
    Then tenant "anthus" can list bots for user "ryan":
      | Researcher |
      | Writer     |

  Scenario: A bot can be read by identifier after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When bot "Researcher" remembers "voice" as "short and direct"
    And a recycled Front Door serves the same messaging store
    Then tenant "anthus" can read bot "Researcher" by identifier with memory "voice" as "short and direct"

  Scenario: The web UI shows an empty bot roster
    Given an empty control plane
    When the web UI requests the bot roster for tenant "anthus" user "ryan"
    Then the web UI bot roster is empty
