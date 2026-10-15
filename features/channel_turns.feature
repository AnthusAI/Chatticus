Feature: Channels and the message store
  As a Chatticus user
  I want conversations stored as append-only messages in channels
  So that bots can talk to me and to each other on one channel
  And files stay on the shared computer instead of in the transcript

  Scenario: The front door names its cloud environment
    Given a front door serving named environment "development" with HTTP
    Then GET /health reports environment "development"

  Scenario: Answer a text-only message without starting the computer
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And tenant "anthus" user "ryan" household computer is stopped
    When user "ryan" of tenant "anthus" posts a text-only message addressed to bot "Assistant" on the channel
    Then bot "Assistant" completes one turn
    And the channel contains one durable bot answer
    And tenant "anthus" user "ryan" household computer remains stopped

  Scenario: A second bot answer on the same channel joins this turn's chunks
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    Then bot "Assistant" completes one turn
    When user "ryan" of tenant "anthus" posts "what is two plus two" addressed to bot "Assistant" on the channel
    Then bot "Assistant" completes one turn
    And the channel has 4 messages
    And the latest bot message body equals the joined chunks for the active turn

  Scenario: An active turn can be read after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Researcher |
    And user "ryan" of tenant "anthus" posts a fence probe addressed to bot "Researcher" without enqueueing a turn job
    And a recycled Front Door serves the same messaging store
    Then tenant "anthus" can read the active turn on the open channel

  Scenario: No active turn is reported after completion and a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Researcher |
    And user "ryan" of tenant "anthus" posts a fence probe addressed to bot "Researcher" without enqueueing a turn job
    And the worker claims the fence probe turn and completes it through HTTP
    And a recycled Front Door serves the same messaging store
    Then tenant "anthus" cannot read an active turn on the open channel

  Scenario: A failed turn is still the channel's latest turn after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And the model provider answers every request with status 429 and error code "insufficient_quota"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Researcher" on the channel
    And bot "Researcher" runs one computerless worker turn against that provider
    And a recycled Front Door serves the same messaging store
    Then tenant "anthus" cannot read an active turn on the open channel
    And tenant "anthus" reads the latest turn on the open channel as failed with reason "The model provider refused the request: the account is out of credits or over its quota."
    And the latest turn names the message "hello" as its prompt

  Scenario: The newest of two overlapping turns is the channel's latest turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Researcher |
      | Writer     |
    And user "ryan" of tenant "anthus" posts "first" addressed to bot "Researcher" on the channel
    And the open turn is remembered as "older"
    And user "ryan" of tenant "anthus" posts "second" addressed to bot "Writer" on the channel
    And a worker claims the turn remembered as "older"
    Then the latest turn on the open channel is addressed to bot "Writer"

  Scenario: Another tenant cannot read a channel's latest turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And another tenant "other" knows the channel identifier
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    And tenant "other" reads the latest turn on the open channel
    Then the latest turn is not found

  Scenario: A waiting turn can be read after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And user "ryan" of tenant "anthus" has an active turn on the channel
    When the worker posts a progress chunk and then waits on the browser gate
    And a recycled Front Door serves the same messaging store
    Then tenant "anthus" can read the waiting turn on the open channel as browser

  Scenario: A turn can be read by identifier after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Researcher |
    And user "ryan" of tenant "anthus" posts a fence probe addressed to bot "Researcher" without enqueueing a turn job
    And a recycled Front Door serves the same messaging store
    Then tenant "anthus" can read the turn by identifier
