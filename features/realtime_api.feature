Feature: Realtime API for chattic.us
  As the chattic.us web app
  I want a realtime API on the control plane
  So that response tokens stream over an open socket
  Without storing a message row per token
  And without a managed GraphQL subscription bus

  Scenario: A committed message is pushed on the realtime API
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a thread with bots:
      | Researcher |
    And tenant "anthus" is subscribed to the thread realtime API
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Researcher"
    Then the subscription received event "thread.message.created" for seq 1

  Scenario: Tokens stream on the realtime API and coalesce into one message
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a thread with bots:
      | Researcher |
    And tenant "anthus" is subscribed to the thread realtime API
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Researcher"
    And bot "Researcher" starts a turn stream on the thread
    And the turn stream appends token "Hel"
    And the turn stream appends token "lo"
    Then the thread has 1 message
    And the subscription received event "turn.token" with token "Hel"
    And the subscription received event "turn.token" with token "lo"
    When the turn stream completes
    Then the thread has 2 messages
    And the message with seq 2 has body "Hello"
    And the subscription received event "turn.completed" for seq 2

  Scenario: Reconnect replays committed messages after a sequence
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a thread with bots:
      | Researcher |
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Researcher"
    And bot "Researcher" starts a turn stream on the thread
    And the turn stream appends token "Hel"
    And the turn stream appends token "lo"
    And the turn stream completes
    Then listing messages after seq 1 returns 1 message
    And those messages start at seq 2 with body "Hello"

  Scenario: Another tenant cannot subscribe to the realtime API
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a thread with bots:
      | Researcher |
    When tenant "other" subscribes to the thread realtime API
    Then the realtime subscription fails because the tenant does not match
