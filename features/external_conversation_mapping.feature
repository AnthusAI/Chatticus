Feature: An external conversation is one Chatticus channel
  As a member of an organization
  I want a conversation I have by email or text with a bot to appear as one ordinary channel
  So that I can read it in the web app, and so that no second kind of thread exists beside the channel

  An external conversation maps onto exactly one channel and never onto a new object. A thread conversation, such as an
  email thread, opens one external channel named from its subject. A pair conversation, such as a direct message or a
  text, lands in the member's existing direct channel with the bot. The mapping is found again from the conversation key,
  and from any earlier message the new one references. The contract is docs/EXTERNAL_CHANNELS.md.

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

  Scenario: The first message of a thread opens one external channel and the second lands in it
    When a message arrives over the fake transport:
      | to           | researcher-line     |
      | from         | sam-phone           |
      | id           | m1                  |
      | conversation | thread-1            |
      | subject      | Quarterly plan      |
      | text         | Where do we start?  |
    And a message arrives over the fake transport:
      | to           | researcher-line     |
      | from         | sam-phone           |
      | id           | m2                  |
      | conversation | thread-1            |
      | text         | And the budget?     |
    Then "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And the external channel of "sam@example.com" in "Anthus Labs" is named "Quarterly plan"
    And that channel has 2 messages

  Scenario: A new conversation key opens a second channel
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | First topic     |
    And a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m2              |
      | conversation | thread-2        |
      | text         | Second topic    |
    Then "sam@example.com" has 2 channels of kind "external" in "Anthus Labs"

  Scenario: A reply that quotes an earlier message finds its thread even when the conversation key changed
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | First topic     |
    And a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m2              |
      | conversation | thread-renamed  |
      | references   | m1              |
      | text         | Still the first topic |
    Then "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And that channel has 2 messages

  Scenario: A pair conversation lands in the member's existing direct channel
    Given the fake transport carries pair conversations
    And "sam@example.com" has a direct channel with the bot "Researcher" in "Anthus Labs"
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | t1              |
      | conversation | sam-phone:line  |
      | text         | A text message  |
    Then "sam@example.com" has 0 channels of kind "external" in "Anthus Labs"
    And "sam@example.com" has 1 channel of kind "direct" in "Anthus Labs"
    And that channel has 1 message

  Scenario: Messages show where they came from and web messages show nothing
    Given "sam@example.com" has a direct channel with the bot "Writer" in "Anthus Labs"
    When "sam@example.com" posts "From the web" on that channel addressed to the bot "Writer"
    And a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | From outside    |
    Then the messages of the direct channel of "sam@example.com" with the bot "Writer" in "Anthus Labs" show no origin
    And the messages of the external channel of "sam@example.com" in "Anthus Labs" show the origin provider "fake" and external message "m1"

  Scenario: Only the linked member's channel list shows the external channel
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Private to Sam  |
    Then "ada@example.com" has 0 channels of kind "external" in "Anthus Labs"
    And "ada@example.com" is refused when reading the external channel of "sam@example.com" in "Anthus Labs"

  Scenario: Someone outside the organization is refused as a non-member and learns nothing about the channel
    Given the organization "Other House" has the owner "olive@example.org"
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Private to Sam  |
    Then "olive@example.org" is refused as a non-member when reading the external channel of "sam@example.com" in "Anthus Labs"

  Scenario: Replaying the same external message creates no second channel or message
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Once            |
    And the same fake request is delivered 2 more times
    Then "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And that channel has 1 message
