Feature: Inbound external messages are admitted through one path
  As an operator of Chatticus
  I want every message that arrives from outside to pass the same deterministic checks before any bot sees it
  So that a repeated delivery, an unknown address or a switched-off binding costs nothing and reveals nothing

  Every transport hands the core a provider-neutral event and the core decides. It resolves the route, checks that the
  organization, the binding and the feature are on, resolves the sender to a linked member, deduplicates, finds or opens
  the one channel the conversation is, and then uses the existing message admission, so steering and turn start behave as
  they do for a web message. Milestone 1 knows one kind of sender: a member whose external identity an owner linked.
  The contract is docs/EXTERNAL_CHANNELS.md.

  Background:
    Given an empty control plane
    And external channels are configured for this environment with the mail domain "mail.develop.example.test"
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Anthus Labs" has the bot "Researcher"
    And the organization "Anthus Labs" has the bot "Writer"
    And external channels are switched on for the organization "Anthus Labs"
    And the fake route "researcher-line" of "Anthus Labs" is bound to the bot "Researcher"
    And the fake route "writer-line" of "Anthus Labs" is bound to the bot "Writer"
    And the fake sender "sam-phone" is linked to "sam@example.com" in "Anthus Labs"

  Scenario: A linked member's message starts a turn for the addressed bot exactly once
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Please research this |
    And the same fake request is delivered 2 more times
    Then the message was admitted
    And the bot "Researcher" has 1 turn queued
    And the external channel of "sam@example.com" in "Anthus Labs" has the message "Please research this" written by "sam@example.com"
    And that channel has 1 message

  Scenario: A copied bot reads the message and does not act on it
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | cc           | writer-line     |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Researcher, take this one |
    Then the message was admitted
    And the bot "Researcher" has 1 turn queued
    And the bot "Writer" has 0 turns queued
    And the external channel of "sam@example.com" in "Anthus Labs" has the bots "Researcher" and "Writer" as participants
    And that channel has 1 message

  Scenario: A second message while the turn is open steers the same turn
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | First thought   |
    And a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m2              |
      | conversation | thread-1        |
      | text         | Second thought  |
    Then both messages joined the same turn
    And the bot "Researcher" has 1 turn queued

  Scenario: A message for an unknown address stores nothing and reveals nothing
    Given the Messaging table is counted
    When a message arrives over the fake transport:
      | to           | nobody-line     |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Is anyone there? |
    Then the message was dropped as "unknown_route"
    And the Messaging table holds the same items as when it was counted
    And the counter "inbound_unknown_route" was counted 1 time

  Scenario: A disabled binding admits nothing
    Given the owner "ryan@example.com" disables the fake route "researcher-line" of "Anthus Labs"
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Anyone?         |
    Then the message was dropped as "gate_closed"
    And the bot "Researcher" has 0 turns queued
    And "sam@example.com" has 0 channels of kind "external" in "Anthus Labs"

  Scenario: A suspended organization admits nothing
    Given the organization "Anthus Labs" is suspended by the operator
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Anyone?         |
    Then the message was dropped as "gate_closed"
    And the bot "Researcher" has 0 turns queued

  Scenario: Switching the feature off for the organization admits nothing
    Given external channels are switched off for the organization "Anthus Labs"
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Anyone?         |
    Then the message was dropped as "gate_closed"

  Scenario: The environment kill switch admits nothing
    Given the environment kill switch for external channels is engaged
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Anyone?         |
    Then the message was dropped as "gate_closed"

  Scenario: A sender nobody linked starts nothing
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | stranger-phone  |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Hello           |
    Then the message was dropped as "unlinked_sender"
    And the bot "Researcher" has 0 turns queued
    And "sam@example.com" has 0 channels of kind "external" in "Anthus Labs"

  Scenario: A member who was removed stops being admitted at the next message
    Given "ryan@example.com" removes "sam@example.com" from "Anthus Labs"
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Still here?     |
    Then the message was dropped as "unlinked_sender"

  Scenario: A request with a bad signature admits nothing
    When a fake request with a bad signature arrives:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Forged          |
    Then the fake request was refused
    And the bot "Researcher" has 0 turns queued
