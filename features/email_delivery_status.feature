Feature: What SES says about a sent reply is recorded, and an address that bounced or complained is never mailed again
  As an owner who connected a bot to email
  I want the delivery of every reply to settle into a state I can read, and a bad address to stop costing reputation
  So that a bounce is visible, a complaint ends the mailing, and the SES sandbox or throttling never loses a reply silently

  The email transport sends through SES v2 and classifies what comes back. Throttling is retried by the delivery
  handler's own bound and nothing here retries it again. A refusal, an unverified recipient in the SES sandbox, and a
  suppressed address are permanent. Events from the configuration set arrive through SNS and move the delivery to
  delivered, bounced or complained. A permanent bounce or a complaint adds the recipient to the binding's suppression, and
  a suppressed address is refused before SES is asked. A transient bounce changes nothing. SES publishes the events and
  this feature feeds the same event shapes to the transport; no test calls Amazon. The contract is docs/EXTERNAL_CHANNELS.md.

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

  Scenario Outline: SES answers a send with a failure and the delivery records how it was classified
    Given SES will fail the next send as "<ses failure>"
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the delivery of the reply is "<state>" with the reason "<reason>"

    Examples:
      | ses failure                  | state     | reason                            |
      | throttled                    | retryable | ses_throttled                     |
      | unavailable                  | retryable | ses_unavailable                   |
      | rejected                     | failed    | ses_rejected                      |
      | sandbox_unverified_recipient | failed    | sandbox_recipient_not_verified    |
      | suppressed                   | failed    | ses_account_suppressed            |

  Scenario: A repeated send with the same idempotency key does not ask SES twice
    When the email transport sends a reply to "sam.sender@example.test" in a thread whose subject is "Plan"
    And the same reply is sent again with the same idempotency key
    Then the fake SES was asked to send 1 mail

  Scenario: A delivery notification marks the reply delivered
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And SES reports "Delivery" for the last sent mail
    Then the delivery of the reply is "delivered"

  Scenario: A permanent bounce marks the reply bounced and suppresses the recipient for the binding
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And SES reports "Bounce" of type "Permanent" for the last sent mail to "sam.sender@example.test"
    Then the delivery of the reply is "bounced"
    And "sam.sender@example.test" is suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

  Scenario: A suppressed recipient is never mailed again
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And SES reports "Bounce" of type "Permanent" for the last sent mail to "sam.sender@example.test"
    And the model will answer "Are you there?"
    And an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Re: Quarterly plan                          |
      | id      | second-1@mail.example.test                  |
      | in-reply-to | root-1@mail.example.test                |
      | references  | root-1@mail.example.test                |
      | body    | Hello again                                 |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the fake SES was asked to send 1 mail
    And the delivery of the reply is "failed" with the reason "recipient_suppressed"

  Scenario: A complaint marks the reply complained and suppresses the recipient
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And SES reports "Complaint" for the last sent mail to "sam.sender@example.test"
    Then the delivery of the reply is "complained"
    And "sam.sender@example.test" is suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

  Scenario: A transient bounce changes nothing and suppresses nobody
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And SES reports "Bounce" of type "Transient" for the last sent mail to "sam.sender@example.test"
    Then the delivery of the reply is "sent"
    And "sam.sender@example.test" is not suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

  Scenario: An SES rejection marks the reply bounced and does not suppress the recipient
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And SES reports "Reject" for the last sent mail
    Then the delivery of the reply is "bounced" with the reason "ses_reject"
    And "sam.sender@example.test" is not suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

  Scenario Outline: A notification that names no reply of ours, or is not an SES event, changes nothing
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And this notification arrives from SNS: <notification>
    Then the delivery of the reply is "sent"
    And "sam.sender@example.test" is not suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

    Examples:
      | notification                                                                                                                                                                   |
      | {"Type":"Notification","Message":"{\"eventType\":\"Bounce\",\"bounce\":{\"bounceType\":\"Permanent\",\"bouncedRecipients\":[{\"emailAddress\":\"sam.sender@example.test\"}]},\"mail\":{\"messageId\":\"someone-elses-message\"}}"} |
      | {"Type":"SubscriptionConfirmation","Message":"confirm"}                                                                                                                         |
      | this is not json                                                                                                                                                                |
      | {"Type":"Notification","Message":"not json either"}                                                                                                                              |
