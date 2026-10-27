Feature: A reply the event bus announces is sent through SES once, and a send that can be retried is retried by the platform
  As an owner who connected a bot to email
  I want each owed reply to leave through SES exactly once and to be tried again when SES is only busy
  So that a repeated event never mails twice, a throttled send is not lost, and a refusal is recorded where I can read it

  The delivery function is invoked by the event bus for each announcement of a reply owed to an external transport. The
  announcement carries ids only. The function composes the same channel runtime as the front door, with the real email
  transport registered, and runs the existing delivery path: it loads the reply, refuses when the binding, the environment
  or the organization is closed, renders, checks the suppression list, and sends once through the SES client with the
  configuration set. A repeated event for a reply that already left sends nothing. A send SES refused for a lasting reason is
  recorded as failed and the function succeeds. A send that failed in a way that may pass, such as throttling, leaves the
  delivery retryable and fails the function, so the platform's own retry runs it again. No test calls Amazon. The contract
  is docs/EXTERNAL_CHANNELS.md.

  Background:
    Given an empty control plane
    And external channels are configured for this environment with the mail domain "mail.develop.example.test"
    And outbound email goes through a fake SES client with the configuration set "chatticus-development-outbound" and the web app at "https://hey.example.test"
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Anthus Labs" has the bot "Researcher"
    And external channels are switched on for the organization "Anthus Labs"
    And "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And "ryan@example.com" has created an email binding for the bot "Researcher" in "Anthus Labs"
    And the email sender "sam.sender@example.test" is linked to "sam@example.com" in "Anthus Labs"
    And the model will answer "The research is done."
    And an email from "sam.sender@example.test" to the bot "Researcher" was answered

  Scenario: The announced reply is sent once through the configuration set and recorded as sent
    When the event bus delivers the reply event to the delivery function
    Then the delivery function succeeded
    And the fake SES was asked to send 1 mail
    And the sent mail was addressed to exactly "sam.sender@example.test"
    And the sent mail went out through the configuration set "chatticus-development-outbound"
    And the delivery of the reply is "sent"

  Scenario: The same announcement twice sends one mail
    When the event bus delivers the reply event to the delivery function
    And the event bus delivers the reply event to the delivery function again
    Then the delivery function succeeded
    And the fake SES was asked to send 1 mail

  Scenario Outline: An event that is not an announcement of an owed reply is ignored
    When the event bus delivers an event from "<source>" of the type "<detail type>" with the ids "<ids>"
    Then the delivery function succeeded
    And the fake SES was asked to send 0 mails

    Examples:
      | source             | detail type              | ids                |
      | someone.else       | channel.message.created  | complete           |
      | chatticus.channels | something.else           | complete           |
      | chatticus.channels | channel.message.created  | no message id      |
      | chatticus.channels | channel.message.created  | a number as tenant |

  Scenario: An announcement of a reply that was never recorded sends nothing
    When the event bus delivers an announcement of a reply that was never recorded
    Then the delivery function succeeded
    And the fake SES was asked to send 0 mails

  Scenario: SES throttling leaves the delivery retryable and fails the function so that the platform retries
    Given SES will fail the next send as "throttled"
    When the event bus delivers the reply event to the delivery function
    Then the delivery function failed so that the platform retries
    And the delivery of the reply is "retryable" with the reason "ses_throttled"
    When the event bus delivers the reply event to the delivery function again
    Then the delivery function succeeded
    And the delivery of the reply is "sent"
    And the fake SES was asked to send 1 mail

  Scenario: A lasting refusal from SES is recorded and does not fail the function
    Given SES will fail the next send as "sandbox_unverified_recipient"
    When the event bus delivers the reply event to the delivery function
    Then the delivery function succeeded
    And the delivery of the reply is "failed" with the reason "sandbox_recipient_not_verified"

  Scenario: A recipient that bounced before is refused before SES is asked
    Given "sam.sender@example.test" was suppressed after a bounce for the email binding of the bot "Researcher" in "Anthus Labs"
    When the event bus delivers the reply event to the delivery function
    Then the delivery function succeeded
    And the fake SES was asked to send 0 mails
    And the delivery of the reply is "failed" with the reason "recipient_suppressed"

  Scenario: A reply owed after the organization was switched off is not sent
    Given the operator switches external channels off for the organization "Anthus Labs"
    When the event bus delivers the reply event to the delivery function
    Then the delivery function succeeded
    And the fake SES was asked to send 0 mails
    And the delivery of the reply is "failed" with the reason "external_channels_off"
