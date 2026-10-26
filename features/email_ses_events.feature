Feature: SES delivery events change a delivery only when SNS signed them for the configured topic
  As an owner who connected a bot to email
  I want a bounce or a complaint to be believed only when it really came from SNS for our own topic
  So that nobody who knows one message id can forge a bounce, suppress a recipient or mark a reply delivered

  The configuration set publishes send, delivery, bounce, complaint and reject events to one SNS topic, and the status
  function is subscribed to it. Before the function reads an event it checks the message the way SNS documents: the signing
  certificate must be served by sns.<region>.amazonaws.com over https from a plain path, the topic must be the configured
  topic, the signature version must be 1 or 2, the signature must verify over the canonical string with the certificate's key,
  and the timestamp must be recent. Anything else is rejected, counted by reason, and not retried, because retrying cannot
  make a forged message true. A failure to fetch the certificate is not a verdict about the message, so the function fails
  and the platform retries. A subscription confirmation is never accepted: the function is subscribed by the platform and
  receives notifications only. The tests sign with a key pair generated for the scenario and serve its certificate from a
  fake certificate source; no test calls Amazon. The contract is docs/EXTERNAL_CHANNELS.md.

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
    And the reply was sent through SES
    And SNS signs with a generated test key pair for the topic "arn:aws:sns:us-east-1:111122223333:chatticus-development-mail-events" in "us-east-1"

  Scenario Outline: A delivery notification signed with either signature version marks the reply delivered
    When SNS delivers a signed SES "Delivery" event for the last sent mail with signature version "<version>"
    Then the status function succeeded
    And the delivery of the reply is "delivered"
    And the counter "status_event_rejected" was counted 0 times

    Examples:
      | version |
      | 1       |
      | 2       |

  Scenario: A permanent bounce marks the reply bounced and suppresses the recipient
    When SNS delivers a signed SES "Bounce" of type "Permanent" event for the last sent mail to "sam.sender@example.test"
    Then the status function succeeded
    And the delivery of the reply is "bounced"
    And "sam.sender@example.test" is suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

  Scenario: A complaint marks the reply complained and suppresses the recipient
    When SNS delivers a signed SES "Complaint" event for the last sent mail to "sam.sender@example.test"
    Then the status function succeeded
    And the delivery of the reply is "complained"
    And "sam.sender@example.test" is suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

  Scenario: The same notification delivered twice changes the delivery once
    When SNS delivers a signed SES "Delivery" event for the last sent mail
    And SNS delivers the same notification again
    Then the status function succeeded
    And the delivery of the reply is "delivered"

  Scenario Outline: A certificate that is not served by SNS of this region over https is rejected without being fetched
    When SNS delivers a signed SES "Bounce" of type "Permanent" event for the last sent mail to "sam.sender@example.test" whose certificate is at "<certificate url>"
    Then the status function succeeded
    And the notification was rejected as "<reason>"
    And no certificate was fetched
    And the delivery of the reply is "sent"
    And "sam.sender@example.test" is not suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

    Examples:
      | certificate url                                                                   | reason                 |
      | https://sns.us-east-1.amazonaws.com.attacker.example.test/SimpleNotificationService-test.pem | signing_certificate_url |
      | https://attacker.example.test/SimpleNotificationService-test.pem                  | signing_certificate_url |
      | http://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem             | signing_certificate_url |
      | https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem            | signing_certificate_url |
      | https://sns.us-east-1.amazonaws.com:8443/SimpleNotificationService-test.pem       | signing_certificate_url |
      | https://sns.us-east-1.amazonaws.com@attacker.example.test/SimpleNotificationService-test.pem | signing_certificate_url |
      | https://sns.us-east-1.amazonaws.com/other/SimpleNotificationService-test.pem      | signing_certificate_url |
      | https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem?x=1        | signing_certificate_url |
      | https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.txt            | signing_certificate_url |

  Scenario: A notification for another topic is rejected even when its signature is valid
    When SNS delivers a signed SES "Bounce" of type "Permanent" event for the last sent mail to "sam.sender@example.test" from the topic "arn:aws:sns:us-east-1:111122223333:some-other-topic"
    Then the status function succeeded
    And the notification was rejected as "topic_arn"
    And the delivery of the reply is "sent"
    And "sam.sender@example.test" is not suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

  Scenario: A notification whose subscription belongs to another topic is rejected
    When SNS delivers a signed SES "Delivery" event for the last sent mail with the subscription of another topic
    Then the status function succeeded
    And the notification was rejected as "topic_arn"
    And the delivery of the reply is "sent"

  Scenario: A notification whose body was changed after signing is rejected
    When SNS delivers a signed SES "Delivery" event for the last sent mail whose message is changed afterwards to a "Bounce"
    Then the status function succeeded
    And the notification was rejected as "signature"
    And the delivery of the reply is "sent"

  Scenario: A notification signed by a key that is not the certificate's key is rejected
    When SNS delivers a signed SES "Bounce" of type "Permanent" event for the last sent mail to "sam.sender@example.test" signed by another key
    Then the status function succeeded
    And the notification was rejected as "signature"
    And the delivery of the reply is "sent"
    And "sam.sender@example.test" is not suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

  Scenario: A notification with no signature is rejected
    When SNS delivers an unsigned SES "Bounce" of type "Permanent" event for the last sent mail to "sam.sender@example.test"
    Then the status function succeeded
    And the notification was rejected as "unsigned"
    And the delivery of the reply is "sent"
    And "sam.sender@example.test" is not suppressed for the email binding of the bot "Researcher" in "Anthus Labs"

  Scenario: A signature version other than 1 or 2 is rejected
    When SNS delivers a signed SES "Delivery" event for the last sent mail with signature version "3"
    Then the status function succeeded
    And the notification was rejected as "signature_version"
    And the delivery of the reply is "sent"

  Scenario Outline: A notification whose timestamp is too old or in the future is rejected
    When SNS delivers a signed SES "Delivery" event for the last sent mail stamped <offset> now
    Then the status function succeeded
    And the notification was rejected as "timestamp"
    And the delivery of the reply is "sent"

    Examples:
      | offset                |
      | 3 hours before        |
      | 10 minutes after      |

  Scenario: A subscription confirmation is never accepted
    When SNS delivers a signed subscription confirmation for the configured topic
    Then the status function succeeded
    And the notification was rejected as "unsupported_type"
    And nothing was fetched from the subscribe address

  Scenario: A certificate that cannot be fetched fails the function so that the platform retries
    Given the certificate source is unavailable
    When SNS delivers a signed SES "Delivery" event for the last sent mail
    Then the status function failed so that the platform retries
    And the delivery of the reply is "sent"
    When the certificate source recovers
    And SNS delivers the same notification again
    Then the status function succeeded
    And the delivery of the reply is "delivered"

  Scenario: A notification for a message this system never sent changes nothing
    When SNS delivers a signed SES "Bounce" of type "Permanent" event for an unknown message to "sam.sender@example.test"
    Then the status function succeeded
    And "sam.sender@example.test" is not suppressed for the email binding of the bot "Researcher" in "Anthus Labs"
    And the delivery of the reply is "sent"
