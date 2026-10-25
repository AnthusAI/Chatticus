Feature: A bot's reply follows the message that started its turn
  As a member who wrote to a bot from outside the web app
  I want the answer to come back the way I asked
  So that an email gets an email reply in the same thread, and a turn I started in the web app never leaks to an outside address

  When a turn finishes, the control plane commits the answer and, only when the turn's prompt arrived over an external
  transport, records a delivery owed to that transport and tells the delivery handler with ids only. The handler renders
  the answer, sends it once per message and binding, and records the result. Provider callbacks update the same record,
  and a sweeper retries what is stuck and gives up after a bound. The contract is docs/EXTERNAL_CHANNELS.md.

  Background:
    Given an empty control plane
    And external channels are configured for this environment with the mail domain "mail.develop.example.test"
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Anthus Labs" has the bot "Researcher"
    And external channels are switched on for the organization "Anthus Labs"
    And the fake route "researcher-line" of "Anthus Labs" is bound to the bot "Researcher"
    And the fake sender "sam-phone" is linked to "sam@example.com" in "Anthus Labs"
    And the model will answer "The research is done."

  Scenario: A reply to an external prompt is delivered once to the thread it came from
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Please research this |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the fake provider sent 1 message
    And the fake provider sent "The research is done." to "sam-phone" in the conversation "thread-1" in reply to "m1"
    And the delivery of the reply is "sent"

  Scenario: A turn started in the web app is not delivered outside
    Given "sam@example.com" has a direct channel with the bot "Researcher" in "Anthus Labs"
    When "sam@example.com" posts "From the web" on that channel addressed to the bot "Researcher"
    And the bot "Researcher" completes its turn
    Then no delivery was recorded
    And the fake provider sent 0 messages

  Scenario: A web message on an external channel after the first turn is not delivered outside
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | From outside    |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And "sam@example.com" posts "From the web" on the external channel addressed to the bot "Researcher"
    And the model will answer "A web answer."
    And the bot "Researcher" completes its turn
    Then 1 delivery was recorded
    And the fake provider sent 1 message

  Scenario: The event that wakes the delivery handler carries ids only
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Please research this |
    And the bot "Researcher" completes its turn
    Then exactly 1 channel event was published
    And the channel event carries only the tenant, message and binding ids
    And the channel event does not contain the answer text or the sender

  Scenario: The same event delivered twice sends once
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Please research this |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And the delivery handler runs for the reply
    Then the fake provider sent 1 message
    And the fake provider was asked to send 1 time

  Scenario: A transient failure is retried by the sweeper and produces one provider send
    Given the fake provider fails its next delivery as retryable "provider_busy"
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Please research this |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the delivery of the reply is "retryable" with the reason "provider_busy"
    And the fake provider sent 0 messages
    When the clock moves forward 4 minutes
    And the sweeper runs
    Then the fake provider sent 1 message
    And the delivery of the reply is "sent"

  Scenario: A permanent failure is recorded with a reason the owner can read
    Given the fake provider fails its next delivery as permanent "recipient_unknown"
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Please research this |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the delivery of the reply is "failed" with the reason "recipient_unknown"
    And "sam@example.com" reads the deliveries of the fake route "researcher-line" of "Anthus Labs"
    And the listed delivery is "failed" with the reason "recipient_unknown" and no message text

  Scenario: The sweeper gives up after the bound
    Given the fake provider fails its next 10 deliveries as retryable "provider_busy"
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Please research this |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And 6 sweeps find the delivery stale
    Then the delivery of the reply is "failed" with the reason "retries_exhausted"
    And the fake provider sent 0 messages
    And the fake provider was asked to send 5 times

  Scenario: A steered turn answers the last external message it was told
    Given the model will answer "Both thoughts are covered."
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
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the fake provider sent 1 message
    And the fake provider sent "Both thoughts are covered." to "sam-phone" in the conversation "thread-1" in reply to "m2"

  Scenario: A disabled binding stops delivery
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Please research this |
    And the bot "Researcher" completes its turn
    And the owner "ryan@example.com" disables the fake route "researcher-line" of "Anthus Labs"
    And the delivery handler runs for the reply
    Then the fake provider sent 0 messages
    And the delivery of the reply is "failed" with the reason "binding_disabled"

  Scenario: A suspended organization sends nothing
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Please research this |
    And the bot "Researcher" completes its turn
    And the organization "Anthus Labs" is suspended by the operator
    And the delivery handler runs for the reply
    Then the fake provider sent 0 messages
    And the delivery of the reply is "failed" with the reason "organization_suspended"

  Scenario: A web message that steers an external turn does not change who the reply is owed to
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | From outside    |
    And "sam@example.com" posts "From the web" on the external channel addressed to the bot "Researcher"
    And the model will answer "Answered both."
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the fake provider sent 1 message
    And the fake provider sent "Answered both." to "sam-phone" in the conversation "thread-1" in reply to "m1"
    And the message "From the web" on the external channel of "sam@example.com" in "Anthus Labs" shows no origin

  Scenario: Provider callbacks update the delivery
    When a message arrives over the fake transport:
      | to           | researcher-line |
      | from         | sam-phone       |
      | id           | m1              |
      | conversation | thread-1        |
      | text         | Please research this |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And the fake provider reports the reply as "delivered"
    Then the delivery of the reply is "delivered"
    When the fake provider reports the reply as "bounced"
    Then the delivery of the reply is "bounced"

  Scenario: A callback about a message nobody sent changes nothing
    When the fake provider reports an unknown message as "complained"
    Then no delivery was recorded
