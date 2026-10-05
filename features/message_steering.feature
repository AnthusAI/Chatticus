Feature: Messages steer a bot that is already working
  As a Chatticus user
  I want a second message to a busy bot to reach the turn already running
  So that one bot never answers the same channel twice at once and no message is lost

  Scenario: A second message to the same bot joins its running turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    When user "ryan" of tenant "anthus" posts "research the top accounts" addressed to bot "Researcher" on the channel
    And user "ryan" of tenant "anthus" posts "use metric units" addressed to bot "Researcher" on the channel
    Then both posts answered with the same turn
    And bot "Researcher" has 1 pending turn with required capabilities:
      | cpu |
    And the channel has 2 messages
    And the message with seq 2 has body "use metric units"

  Scenario: A message to a different bot starts that bot's own turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
      | Writer     |
    When user "ryan" of tenant "anthus" posts "research the top accounts" addressed to bot "Researcher" on the channel
    And user "ryan" of tenant "anthus" posts "draft the summary" addressed to bot "Writer" on the channel
    Then the two posts started different turns
    And bot "Researcher" has 1 pending turn with required capabilities:
      | cpu |
    And bot "Writer" has 1 pending turn with required capabilities:
      | cpu |
    And the channel has 2 messages

  Scenario: A message addressed to nobody starts no turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    When user "ryan" of tenant "anthus" posts "just thinking out loud" on the channel without addressing a bot
    Then the post started no turn
    And bot "Researcher" has 0 pending turns
    And the channel has 1 message

  Scenario: Retrying a steering post replays the same answer
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    When user "ryan" of tenant "anthus" posts "research the top accounts" addressed to bot "Researcher" on the channel
    And user "ryan" of tenant "anthus" posts "use metric units" addressed to bot "Researcher" on the channel with idempotency key "steer-1"
    And user "ryan" of tenant "anthus" posts "use metric units" addressed to bot "Researcher" on the channel with idempotency key "steer-1"
    Then all three posts answered with the same turn
    And the channel has 2 messages

  Scenario: Simultaneous posts get distinct sequence numbers
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    When user "ryan" of tenant "anthus" posts "one", "two" and "three" on the channel at the same time
    Then the channel messages have sequence numbers 1, 2 and 3
    And bot "Researcher" has 0 pending turns

  Scenario: A person who is not on the channel cannot post
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    When user "stranger" of tenant "anthus" posts "let me in" addressed to bot "Researcher" on the channel
    Then the post is refused because the author is not a participant
    And the channel has 0 messages

  Scenario: A bot that is not on the channel cannot be addressed
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Outsider"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    When user "ryan" of tenant "anthus" posts "are you there" addressed to bot "Outsider" on the channel
    Then the post is refused because the addressee is not a participant
    And the channel has 0 messages
    And bot "Outsider" has 0 pending turns
