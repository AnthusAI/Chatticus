Feature: Thin-turn demo conversation from the CLI
  As a Chatticus operator
  I want a CLI that watches live thin-turn streams
  So that I can see a durable answer without reading acceptance exit codes

  Scenario: Post a message and watch tokens through completion
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    And the demo client watches the turn stream for that channel
    Then the demo client saw turn tokens in order
    And the demo client saw the committed bot reply

  Scenario: Reconnect after a dropped stream replays stored chunks
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    And the demo client watches the turn stream until one token arrives then drops
    And the demo client reconnects to the same turn from stored chunks
    Then the demo client saw turn tokens in order without duplicate sequences
    And the demo client saw the committed bot reply

  Scenario: A second turn commits the streamed answer after a prior bot greeting
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    Then bot "Assistant" completes one turn
    When user "ryan" of tenant "anthus" posts "what is two plus two" addressed to bot "Assistant" on the channel
    And the demo client watches the turn stream for that channel
    Then the demo client saw turn tokens in order
    And the committed bot reply matches the streamed tokens
    And the committed bot reply is not the prior bot greeting on the channel

  Scenario: List in-flight turns after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Assistant"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Assistant |
    And user "ryan" of tenant "anthus" posts a fence probe addressed to bot "Assistant" without enqueueing a turn job
    And a recycled Front Door serves the same messaging store
    Then the demo client lists in-flight turns for user "ryan" of tenant "anthus":
      | 1 |
