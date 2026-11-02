Feature: Several people share one channel with one bot or more
  As a member of an organization
  I want to add colleagues to a channel and remove them again
  So that a team can talk among themselves while a bot reads along and acts only when it is named

  Background:
    Given an empty control plane
    And organization "Anthus Labs" with tenant "anthus" has enabled members:
      | email            |
      | ryan@example.com |
      | sam@example.com  |
      | alex@example.com |
    And organization "Anthus Labs" has organization bots:
      | Researcher |

  Scenario: A named channel needs only one bot, and the bot is not optional
    When "ryan@example.com" opens named channel "story" with organization bot "Researcher"
    Then "ryan@example.com" lists shared channel "story" among their channels
    When "ryan@example.com" tries to open a named channel "empty" with no bot
    Then the request is refused with status 400

  Scenario: People added to a channel read and post in it
    Given "ryan@example.com" opens named channel "story" with organization bot "Researcher"
    When "ryan@example.com" adds "sam@example.com" to shared channel "story"
    And "sam@example.com" posts "hello from sam" naming no bot in shared channel "story"
    And "ryan@example.com" posts "hello from ryan" naming no bot in shared channel "story"
    Then "sam@example.com" can read 2 messages in shared channel "story"
    And "ryan@example.com" can read 2 messages in shared channel "story"
    And "sam@example.com" lists shared channel "story" among their channels

  Scenario: Someone already on the channel can add a colleague
    Given "ryan@example.com" opens named channel "story" with organization bot "Researcher"
    And "ryan@example.com" adds "sam@example.com" to shared channel "story"
    When "sam@example.com" adds "alex@example.com" to shared channel "story"
    Then "alex@example.com" can read 0 messages in shared channel "story"

  Scenario: A message that names no bot waits in the bot's mailbox without starting a turn
    Given "ryan@example.com" opens named channel "story" with organization bot "Researcher"
    And "ryan@example.com" adds "sam@example.com" to shared channel "story"
    When "sam@example.com" posts "can you check the headline?" naming no bot in shared channel "story"
    Then the shared channel post started no turn
    And organization bot "Researcher" has a message from "sam@example.com" saying "can you check the headline?" waiting in shared channel "story"

  Scenario: Removing someone ends their reads and posts
    Given "ryan@example.com" opens named channel "story" with organization bot "Researcher"
    And "ryan@example.com" adds "sam@example.com" to shared channel "story"
    And "sam@example.com" posts "before removal" naming no bot in shared channel "story"
    When "ryan@example.com" removes "sam@example.com" from shared channel "story"
    Then "sam@example.com" cannot read shared channel "story"
    And "sam@example.com" does not list shared channel "story" among their channels
    When "sam@example.com" tries to post "after removal" in shared channel "story"
    Then the request is refused with status 403
    And "ryan@example.com" can read 1 messages in shared channel "story"

  Scenario: A person can leave a channel
    Given "ryan@example.com" opens named channel "story" with organization bot "Researcher"
    And "ryan@example.com" adds "sam@example.com" to shared channel "story"
    When "sam@example.com" removes "sam@example.com" from shared channel "story"
    Then "sam@example.com" cannot read shared channel "story"

  Scenario: Someone outside the channel cannot add people
    Given "ryan@example.com" opens named channel "story" with organization bot "Researcher"
    When "alex@example.com" tries to add "alex@example.com" to shared channel "story"
    Then the request is refused with status 403
    And "alex@example.com" cannot read shared channel "story"

  Scenario: A member cannot remove another member, but an owner can
    Given "ryan@example.com" opens named channel "story" with organization bot "Researcher"
    And "ryan@example.com" adds "sam@example.com" to shared channel "story"
    And "ryan@example.com" adds "alex@example.com" to shared channel "story"
    When "sam@example.com" tries to remove "alex@example.com" from shared channel "story"
    Then the request is refused with status 403
    And "alex@example.com" can read 0 messages in shared channel "story"
    When "ryan@example.com" removes "alex@example.com" from shared channel "story"
    Then "alex@example.com" cannot read shared channel "story"

  Scenario: Only a member of the organization can be added
    Given "ryan@example.com" opens named channel "story" with organization bot "Researcher"
    When "ryan@example.com" tries to add someone outside the organization to shared channel "story"
    Then the request is refused with status 400

  Scenario: A channel keeps at least one person
    Given "ryan@example.com" opens named channel "story" with organization bot "Researcher"
    When "ryan@example.com" tries to remove "ryan@example.com" from shared channel "story"
    Then the request is refused with status 400
    And "ryan@example.com" can read 0 messages in shared channel "story"

  Scenario: A direct channel keeps its one person
    Given "ryan@example.com" opens direct channel "direct" with organization bot "Researcher"
    When "ryan@example.com" tries to add "sam@example.com" to shared channel "direct"
    Then the request is refused with status 400
