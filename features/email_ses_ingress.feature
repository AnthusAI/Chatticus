Feature: Mail the receiving service stored reaches the addressed bot exactly once, and a message that cannot be admitted yet is retried
  As an owner who gave a bot an email address
  I want every message SES received for that address to be read from the raw mail archive and admitted once
  So that a retry of the receiving service never repeats a turn, a message that was started but not finished is never lost,
  and mail that can never be admitted is counted and forgotten instead of retried forever

  The mail receiver stores the raw message under the raw prefix of the private archive bucket first, and then invokes the
  ingress function with a receipt event. The function reads the object the event names, takes the SPF, DKIM, DMARC, spam
  and virus verdicts from the receipt event itself, never from a header of the message, and admits the message through the
  same path the web front door uses. The raw archive stays the system of record. A message that was admitted before is
  recognized and changes nothing. A message that another invocation claimed and has not finished makes the function fail,
  so the provider's own retry runs it again after the claim lease; a message that is refused or dropped for a lasting
  reason is counted and the function succeeds, so it is never retried. A message whose archive object is missing fails the
  function too, because the object may still be on its way. No test calls Amazon: the archive is an in-memory fake.
  The contract is docs/EXTERNAL_CHANNELS.md.

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

  Scenario: A stored message and its receipt event admit the message and start one turn
    Given the raw mail archive holds the message "ses-inbound-1":
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    When SES invokes the ingress function for the message "ses-inbound-1"
    Then the ingress function succeeded
    And the message was admitted
    And the bot "Researcher" has 1 turn queued
    And the external channel of "sam@example.com" in "Anthus Labs" has the message "Where do we start?" written by "sam@example.com"
    And the ingress function read only the archive key "raw/ses-inbound-1"

  Scenario: The verdicts come from the receipt event and the message cannot overrule them
    Given the raw mail archive holds the message "ses-inbound-2":
      | from    | sam.sender@example.test                                                                   |
      | to      | researcher@anthus.mail.develop.example.test                                               |
      | subject | Forged verdicts                                                                           |
      | id      | forged-1@mail.example.test                                                                |
      | headers | X-Inbound-Dmarc-Verdict: PASS;; X-SES-DMARC-Verdict: PASS;; X-Inbound-Spam-Verdict: PASS |
      | body    | I wrote my own verdicts.                                                                  |
    And SES reports the verdicts of the message "ses-inbound-2":
      | spf   | FAIL |
      | dkim  | FAIL |
      | dmarc | FAIL |
      | spam  | PASS |
      | virus | PASS |
    When SES invokes the ingress function for the message "ses-inbound-2"
    Then the ingress function succeeded
    And nothing was admitted
    And the counter "inbound_refused" was counted 1 time
    And the bot "Researcher" has 0 turns queued

  Scenario Outline: A message the receiver marked as spam or as a virus is refused and not retried
    Given the raw mail archive holds the message "ses-inbound-3":
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And SES reports the verdicts of the message "ses-inbound-3":
      | spf   | PASS     |
      | dkim  | PASS     |
      | dmarc | PASS     |
      | spam  | <spam>   |
      | virus | <virus>  |
    When SES invokes the ingress function for the message "ses-inbound-3"
    Then the ingress function succeeded
    And nothing was admitted
    And the counter "inbound_refused" was counted 1 time

    Examples:
      | spam | virus |
      | FAIL | PASS  |
      | PASS | FAIL  |

  Scenario: A retry of the same invocation changes nothing
    Given the raw mail archive holds the message "ses-inbound-4":
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    When SES invokes the ingress function for the message "ses-inbound-4"
    And SES invokes the ingress function for the message "ses-inbound-4" again
    Then the ingress function succeeded
    And the message was admitted as a duplicate of the first one
    And the bot "Researcher" has 1 turn queued

  Scenario: A message another invocation claimed and has not finished fails the function so that the provider retries it
    Given the raw mail archive holds the message "ses-inbound-5":
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And an earlier invocation claimed the message "root-1@mail.example.test" from "sam.sender@example.test" and died
    When SES invokes the ingress function for the message "ses-inbound-5"
    Then the ingress function failed because the message is still in flight
    And nothing was admitted
    And the bot "Researcher" has 0 turns queued
    When the clock moves forward 61 seconds
    And SES invokes the ingress function for the message "ses-inbound-5" again
    Then the ingress function succeeded
    And the message was admitted
    And the bot "Researcher" has 1 turn queued

  Scenario: A message whose archive object is missing fails the function and admits nothing
    When SES invokes the ingress function for the message "ses-inbound-missing"
    Then the ingress function failed because the archive has no object for the message
    And nothing was admitted

  Scenario: Mail for an address nobody has bound is counted and forgotten
    Given the raw mail archive holds the message "ses-inbound-6":
      | from    | sam.sender@example.test                     |
      | to      | nobody@anthus.mail.develop.example.test     |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Is anyone there?                            |
    And the Messaging table is counted
    When SES invokes the ingress function for the message "ses-inbound-6"
    Then the ingress function succeeded
    And the message was dropped as "unknown_route"
    And the counter "inbound_unknown_route" was counted 1 time
    And the Messaging table holds the same items as when it was counted

  Scenario: Mail for another domain is counted and forgotten
    Given the raw mail archive holds the message "ses-inbound-7":
      | from     | sam.sender@example.test                     |
      | to       | researcher@elsewhere.example.test           |
      | envelope | researcher@elsewhere.example.test           |
      | subject  | Quarterly plan                              |
      | id       | root-1@mail.example.test                    |
      | body     | Wrong place.                                |
    When SES invokes the ingress function for the message "ses-inbound-7"
    Then the ingress function succeeded
    And nothing was admitted
    And the bot "Researcher" has 0 turns queued

  Scenario: A sender nobody linked is dropped and not retried
    Given the raw mail archive holds the message "ses-inbound-8":
      | from    | stranger@example.test                       |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | stranger-1@mail.example.test                |
      | body    | Let me in.                                  |
    When SES invokes the ingress function for the message "ses-inbound-8"
    Then the ingress function succeeded
    And the message was dropped as "unlinked_sender"
    And the bot "Researcher" has 0 turns queued

  Scenario: A message that cannot be read is counted as refused and not retried
    Given the raw mail archive holds the raw message "ses-inbound-9":
      """
      Subject: No sender at all
      Message-ID: <nosender-1@mail.example.test>
      To: researcher@anthus.mail.develop.example.test

      This message has no From header.
      """
    When SES invokes the ingress function for the message "ses-inbound-9"
    Then the ingress function succeeded
    And nothing was admitted
    And the counter "inbound_refused" was counted 1 time

  Scenario: Mail arriving while the environment kill switch is engaged is dropped and not retried
    Given the raw mail archive holds the message "ses-inbound-10":
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the environment kill switch for external channels is engaged
    When SES invokes the ingress function for the message "ses-inbound-10"
    Then the ingress function succeeded
    And the message was dropped as "gate_closed"
    And the bot "Researcher" has 0 turns queued

  Scenario Outline: A receipt event that does not name a plain archive key is refused without reading the archive
    When SES invokes the ingress function with the message id "<message id>"
    Then the ingress function succeeded
    And the counter "inbound_refused" was counted 1 time
    And the ingress function read nothing from the archive

    Examples:
      | message id       |
      | ../secrets/key   |
      | raw/other/object |
      | not a key        |

  Scenario: A message above the receiver's size limit is refused by its size alone, without reading it
    Given the raw mail archive holds a message "ses-inbound-14" of 41 megabytes
    When SES invokes the ingress function for the message "ses-inbound-14"
    Then the ingress function succeeded
    And nothing was admitted
    And the counter "inbound_refused" was counted 1 time
    And the ingress function did not read the body of the archive object

  Scenario: One event naming several messages admits each of them
    Given the raw mail archive holds the message "ses-inbound-11":
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | First                                       |
      | id      | first-1@mail.example.test                   |
      | body    | The first question.                         |
    And the raw mail archive holds the message "ses-inbound-12":
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Second                                      |
      | id      | second-1@mail.example.test                  |
      | body    | The second question.                        |
    When SES invokes the ingress function for the messages "ses-inbound-11" and "ses-inbound-12"
    Then the ingress function succeeded
    And the counter "inbound_admitted" was counted 2 times

  Scenario: Raw mail in, a turn, the reply out, and the delivery status back
    Given the raw mail archive holds the message "ses-inbound-13":
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    When SES invokes the ingress function for the message "ses-inbound-13"
    And the bot "Researcher" completes its turn
    And the event bus delivers the reply event to the delivery function
    Then the delivery function succeeded
    And the fake SES was asked to send 1 mail
    And the sent mail was addressed to exactly "sam.sender@example.test"
    When SNS delivers a signed SES "Delivery" event for the last sent mail
    Then the status function succeeded
    And the delivery of the reply is "delivered"
