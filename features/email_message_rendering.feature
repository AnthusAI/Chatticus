Feature: A bot's reply is rendered as one plain text email that threads and cannot be mistaken for a person
  As a member who talks to a bot by email
  I want the answer to arrive as an ordinary reply in my thread, from the bot, to me alone
  So that my mail client keeps one conversation, nobody I copied is mailed by a bot, and our own mail is never answered

  The email transport renders the committed reply as a plain text message. It is from the bot's address, to the sender of the
  message it answers and to nobody else, and it carries the headers that make a client thread it: a Message-ID on our
  mail domain, In-Reply-To the message answered, and References from the thread root to that message. The subject reuses
  the thread's subject with a single Re prefix, and neither a subject nor an address can add a header of its own. The reply
  says what it is: Auto-Submitted auto-replied, X-Chatticus-Origin, X-Chatticus-Hops and a plus tag on Reply-To that finds
  the channel again when a client drops every header. Our own Message-ID carries a keyed marker, so a message that
  comes back wearing one is dropped and counted even when every other header is gone. The contract is
  docs/EXTERNAL_CHANNELS.md.

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

  Scenario: A reply is one plain text mail from the bot to the sender alone
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | cc      | ada.sender@example.test                     |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the fake SES was asked to send 1 mail
    And the sent mail was addressed to exactly "sam.sender@example.test"
    And the sent mail has the header "From" of "researcher@anthus.mail.develop.example.test"
    And the sent mail has the header "To" of "sam.sender@example.test"
    And the sent mail has no "Cc" header
    And the sent mail has no "Bcc" header
    And the sent mail has the subject "Re: Quarterly plan"
    And the sent mail is plain text reading "The research is done."
    And the sent mail went out through the configuration set "chatticus-development-outbound"
    And the delivery of the reply is "sent"

  Scenario: A reply carries the threading headers and a Message-ID on our mail domain
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the sent mail has the header "In-Reply-To" of "<root-1@mail.example.test>"
    And the sent mail has the header "References" of "<root-1@mail.example.test>"
    And the sent mail has a Message-ID on the domain "mail.develop.example.test"

  Scenario: A reply says it is automated and carries the plus tag of its channel
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And the plus tag of the external channel of "sam@example.com" in "Anthus Labs" is known
    Then the sent mail has the header "Auto-Submitted" of "auto-replied"
    And the sent mail has the header "X-Chatticus-Origin" of "mail.develop.example.test"
    And the sent mail has the header "X-Chatticus-Hops" of "1"
    And the sent mail has the header "Reply-To" of "researcher+{tag}@anthus.mail.develop.example.test"

  Scenario: A reply to a reply keeps one thread across three exchanges
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And the model will answer "Start with the budget."
    And the sender answers the last sent mail with the id "second-1@mail.example.test" and the body "And then?"
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the sent mail has the header "In-Reply-To" of "<second-1@mail.example.test>"
    And the sent mail has the header "References" of "<root-1@mail.example.test> <second-1@mail.example.test>"
    When the model will answer "Then the plan."
    And the sender answers the last sent mail with the id "third-1@mail.example.test" and the body "Thanks, and after that?"
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    Then the sent mail has the header "In-Reply-To" of "<third-1@mail.example.test>"
    And the sent mail has the header "References" of "<root-1@mail.example.test> <third-1@mail.example.test>"
    And "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And the fake SES was asked to send 3 mails

  Scenario Outline: The subject of the thread gets a single Re prefix
    When the email transport sends a reply to "sam.sender@example.test" in a thread whose subject is <thread subject>
    Then the sent mail has the subject "<sent subject>"

    Examples:
      | thread subject         | sent subject                |
      | "Quarterly plan"       | Re: Quarterly plan          |
      | "Re: Quarterly plan"   | Re: Quarterly plan          |
      | "RE: re: Re: The plan" | Re: The plan                |
      | "Rendez-vous demain"   | Re: Rendez-vous demain      |
      | "Café über alles" | Re: Café über alles |
      | ""                     | Re: your message            |
      | "Re:"                  | Re: your message            |

  Scenario: A subject cannot add a header
    When the email transport sends a reply to "sam.sender@example.test" in a thread whose subject is "Plan\r\nBcc: evil@example.test\r\nX-Injected: yes"
    Then the sent mail has no "Bcc" header
    And the sent mail has no "X-Injected" header
    And the sent mail was addressed to exactly "sam.sender@example.test"

  Scenario: An address that is not a single plain address is never mailed
    When the email transport sends a reply to "sam.sender@example.test>\r\nBcc: evil@example.test" in a thread whose subject is "Plan"
    Then the fake SES was asked to send 0 mails
    And the last send failed as "permanent" with the reason "invalid_recipient"

  Scenario: A very long reply is cut and points to the web app
    When the email transport sends a reply of 150000 characters to "sam.sender@example.test"
    Then the sent mail text has at most 100500 characters
    And the sent mail text ends with "https://hey.example.test/chat]"
    And the sent mail text starts with "word-0 word-1"

  Scenario: Our own Message-ID is recognised when the mail comes back with every other header removed
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    And the delivery handler runs for the reply
    And the last sent mail comes back to the bot address without its automation headers
    Then the mail that came back was refused as "own_outbound_message_id"
    And the counter "inbound_refused" was counted 1 time

  Scenario: A message id that only looks like ours is an ordinary message
    When an email arrives:
      | from    | sam.sender@example.test                                          |
      | to      | researcher@anthus.mail.develop.example.test                      |
      | subject | Quarterly plan                                                   |
      | id      | chatticus.0123456789abcdef0123.0123456789ab@mail.develop.example.test |
      | body    | Where do we start?                                               |
    Then the message was admitted
    And the counter "inbound_refused" was counted 0 times

  Scenario Outline: An address that is not plain printable ASCII is never mailed
    When the email transport sends a reply to "<recipient>" in a thread whose subject is "Plan"
    Then the fake SES was asked to send 0 mails
    And the last send failed as "permanent" with the reason "invalid_recipient"

    Examples:
      | recipient                      |
      | sam\0.sender@example.test      |
      | sam\t.sender@example.test      |
      | säm.sender@example.test    |
      | sam.sender@example.test\u007f  |

  Scenario: Long message ids keep the References header within the line limit and still send
    When the email transport sends a reply to "sam.sender@example.test" answering a message id of 450 characters in a thread rooted at a message id of 450 characters
    Then the fake SES was asked to send 1 mail
    And the sent mail has a "References" header of at most 998 characters that names the answered message
    And the sent mail has an "In-Reply-To" header of at most 998 characters

  Scenario: A message id too large to put in a header is left out and the reply still sends
    When the email transport sends a reply to "sam.sender@example.test" answering a message id of 900 characters in a thread rooted at a message id of 900 characters
    Then the fake SES was asked to send 1 mail
    And the sent mail has no "In-Reply-To" header
    And the sent mail has no "References" header

  Scenario: A message id that is not a single id is left out and the reply still sends
    When the email transport sends a reply to "sam.sender@example.test" answering the message id "two ids@mail.example.test <x@y>" in a thread rooted at "root-1@mail.example.test"
    Then the fake SES was asked to send 1 mail
    And the sent mail has no "In-Reply-To" header
    And the sent mail has the header "References" of "<root-1@mail.example.test>"
