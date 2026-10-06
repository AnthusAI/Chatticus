Feature: Message admission and listing
  As a Chatticus user
  I want every message admitted into its channel exactly once, in order
  So that bots and people share one history and an addressed bot is woken for it

  Scenario: A human message addressed to a bot enqueues a turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Researcher |
    And user "ryan" of tenant "anthus" posts "research the top accounts" addressed to bot "Researcher" on the channel
    Then the channel has 1 message
    And the message with seq 1 has body "research the top accounts"
    And bot "Researcher" has 1 pending turn with required capabilities:
      | cpu |

  Scenario: A bot messages another bot on the same channel
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
      | Writer     |
    When user "ryan" of tenant "anthus" posts "research then draft" addressed to bot "Researcher" on the channel
    And bot "Researcher" posts "notes are in /workspace/accounts.md" addressed to bot "Writer" on the channel
    Then the channel has 2 messages
    And the message with seq 1 is from the human "ryan"
    And the message with seq 2 is from bot "Researcher"
    And bot "Writer" has 1 pending turn with required capabilities:
      | cpu |
    And the human can read both messages on the channel

  Scenario: Channel history reconnects after a seq
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
      | Writer     |
    When user "ryan" of tenant "anthus" posts "research then draft" addressed to bot "Researcher" on the channel
    And bot "Researcher" posts "notes are in /workspace/accounts.md" addressed to bot "Writer" on the channel
    And user "ryan" of tenant "anthus" lists channel messages after seq 1
    Then the listing contains only the message with seq 2

  Scenario: Channel history reconnects after a seq and a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
      | Writer     |
    When user "ryan" of tenant "anthus" posts "research then draft" addressed to bot "Researcher" on the channel
    And bot "Researcher" posts "notes are in /workspace/accounts.md" addressed to bot "Writer" on the channel
    And a recycled Front Door serves the same messaging store
    And user "ryan" of tenant "anthus" lists channel messages after seq 1
    Then the listing contains only the message with seq 2

  Scenario: Another tenant cannot post on the channel
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    When tenant "other" posts "intrusion" on the channel
    Then posting fails because the tenant does not match
    And the channel has 0 messages

  Scenario: Reject a cross-tenant channel access attempt
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And another tenant "other" knows the channel identifier
    When tenant "other" tries to post or read on the channel
    Then access is denied
    And the channel is unchanged

  Scenario: A probe message can start a turn without enqueueing cpu work
    Given an empty control plane with a cpu enqueue hook
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When user "ryan" of tenant "anthus" posts a fence probe addressed to bot "Assistant" without enqueueing a turn job
    Then the channel has a turn
    And bot "Assistant" has 0 pending turns
    And the cpu enqueue hook was not invoked

  Scenario: Retrying a post with the same idempotency key does not duplicate
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel with idempotency key "retry-1"
    And user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel with idempotency key "retry-1"
    Then the channel has 1 message
    And bot "Assistant" has 1 pending turn with required capabilities:
      | cpu |

  Scenario: Retrying a channel open with the same idempotency key does not duplicate
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Assistant"
    When tenant "anthus" user "ryan" opens a channel with idempotency key "retry-ch" with bots:
      | Assistant |
    And tenant "anthus" user "ryan" opens a channel with idempotency key "retry-ch" with bots:
      | Assistant |
    Then the opened channel identifier is unchanged

  Scenario: A stored channel can be read after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Assistant"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Assistant |
    And a recycled Front Door serves the same messaging store
    Then tenant "anthus" can read the open channel by identifier

  Scenario: A user's channels can be listed after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Researcher |
    And tenant "anthus" user "ryan" opens a channel with bots:
      | Writer |
    When a recycled Front Door serves the same messaging store
    Then tenant "anthus" can list channels for user "ryan":
      | 1 |
      | 2 |
