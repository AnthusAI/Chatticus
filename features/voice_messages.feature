Feature: Understanding what the member meant before a voice line is sent
  As a household member talking to a teammate by voice
  I want my words understood even when speech recognition gets them wrong
  So that the teammate answers what I meant, not what the microphone heard

  Speech-to-text runs in the browser and makes mistakes. Before a spoken line
  becomes a message, the understand-the-user step reads the raw transcript and
  the recent conversation and returns what the member most likely said. Only
  that understood text is posted, as an ordinary message that starts an
  ordinary turn.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Ping"

  Scenario: A spoken line is understood before it is posted
    Given the understand-the-user step hears "ping tell me some thing" as "Ping, tell me something."
    When user "ryan" of tenant "anthus" says "ping tell me some thing" to bot "Ping" on the channel
    Then the latest message on the channel is "Ping, tell me something." from user "ryan"
    And that message starts a turn for bot "Ping"

  Scenario: The understand-the-user step reads the recent conversation
    Given the understand-the-user step hears "what about to morrow" as "What about tomorrow?"
    When user "ryan" of tenant "anthus" posts "What is the weather today?" addressed to bot "Ping" on the channel
    And user "ryan" of tenant "anthus" says "what about to morrow" to bot "Ping" on the channel
    Then the understand-the-user step was given "What is the weather today?" as recent conversation

  Scenario: The understand-the-user step sees at most the ten most recent messages
    Given the channel already has 14 messages
    When user "ryan" of tenant "anthus" says "and the other one" to bot "Ping" on the channel
    Then the understand-the-user step was given 10 recent messages

  Scenario: Speech that carries no message is not sent
    Given the understand-the-user step finds no message in "um uh hmm"
    When user "ryan" of tenant "anthus" says "um uh hmm" to bot "Ping" on the channel
    Then no message is posted for that line
    And no turn starts for that line
