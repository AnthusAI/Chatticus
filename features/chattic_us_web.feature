Feature: chattic.us web surface
  As a Chatticus user
  I want the web UI at chattic.us
  So that I can see my bots and chat with them over the same-origin API

  Scenario: The web UI loads the bot roster from the same-origin API
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    When the web UI requests the bot roster for tenant "anthus" user "ryan"
    Then the web UI bot roster shows:
      | Researcher |
      | Writer     |

  Scenario: Sending a chat message reaches the thin-turn front door
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    When the web UI sends "hello" from user "ryan" of tenant "anthus" addressed to bot "Researcher"
    Then the message is accepted by the thin-turn front door
    And a turn is started for the message

  Scenario: The web UI watches turn progress via server-sent events
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And bot "Researcher" is producing an answer for a turn on the channel
    When the web UI opens a turn stream for user "ryan" of tenant "anthus"
    And the worker posts several coalesced progress chunks for the turn
    Then the web UI receives the chunks in order before completion
