Feature: A raw inbound email becomes one provider-neutral message
  As an operator of Chatticus
  I want the email adapter to turn raw mail into the same inbound event every other transport produces, and to refuse what it cannot read
  So that a bot reads plain text from the person who really sent it, and a hostile or broken message costs nothing and breaks nothing

  The email adapter takes the unmodified message and the verdicts the mail receiver attached, and parses it without
  touching the network. The sender is the From address, never Reply-To. Only a message whose DMARC verdict passed, and
  whose spam and virus verdicts did not fail, is read at all; anything else is refused and counted. The text is the plain
  text part, or the HTML part converted to text, with quoted earlier replies and signatures removed only when that loses
  nothing the sender wrote, and it is cut at 100 KB. Attachments are recorded as metadata only. Headers that mark mail as
  automated become the hints the automation filter already honors. The contract is docs/EXTERNAL_CHANNELS.md.

  Background:
    Given an empty control plane
    And external channels are configured for this environment with the mail domain "mail.develop.example.test"
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Anthus Labs" has the bot "Researcher"
    And the organization "Anthus Labs" has the bot "Writer"
    And external channels are switched on for the organization "Anthus Labs"
    And "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And "ryan@example.com" has created an email binding for the bot "Researcher" in "Anthus Labs"
    And "ryan@example.com" has created an email binding for the bot "Writer" in "Anthus Labs"
    And the email sender "sam.sender@example.test" is linked to "sam@example.com" in "Anthus Labs"
    And the email sender "ada.sender@example.test" is linked to "ada@example.com" in "Anthus Labs"

  Scenario: A plain text mail becomes an event with the sender, subject, text and thread
    When an email arrives:
      | from    | Sam Sender <Sam.Sender AT Example.Test>             |
      | to      | Researcher <researcher@anthus.mail.develop.example.test> |
      | subject | Quarterly plan                                   |
      | id      | root-1@mail.example.test                         |
      | body    | Where do we start?                               |
    Then the message was admitted
    And the parsed email is from "sam.sender@example.test" with the display name "Sam Sender"
    And the parsed email is addressed to "researcher@anthus.mail.develop.example.test"
    And the parsed email has the subject "Quarterly plan" and the message id "root-1@mail.example.test"
    And the parsed email has the conversation key "root-1@mail.example.test" and references nothing
    And the parsed email says the sender was proven by "dmarc_aligned"
    And the external channel of "sam@example.com" in "Anthus Labs" has the message "Where do we start?" written by "sam@example.com"

  Scenario: The thread root is the first reference and every earlier message is a lookup candidate
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Re: Quarterly plan                               |
      | id          | reply-3@mail.example.test                        |
      | in-reply-to | reply-2@mail.example.test                        |
      | references  | root-1@mail.example.test, reply-1@mail.example.test, reply-2@mail.example.test |
      | body        | And the schedule?                                |
    Then the parsed email has the conversation key "root-1@mail.example.test"
    And the parsed email references, nearest first, "reply-2@mail.example.test,reply-1@mail.example.test,root-1@mail.example.test"

  Scenario: Without References the in-reply-to message is the thread root
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Re: Quarterly plan                               |
      | id          | reply-3@mail.example.test                        |
      | in-reply-to | reply-2@mail.example.test                        |
      | body        | And the schedule?                                |
    Then the parsed email has the conversation key "reply-2@mail.example.test"
    And the parsed email references, nearest first, "reply-2@mail.example.test"

  Scenario: The To address picks the bot and a copied bot address is a reader
    When an email arrives:
      | from    | sam.sender@example.test                          |
      | to      | researcher@anthus.mail.develop.example.test      |
      | cc      | writer@anthus.mail.develop.example.test, outsider@example.test |
      | subject | Both of you                                      |
      | id      | both-1@mail.example.test                         |
      | body    | Researcher, take this one                        |
    Then the message was admitted
    And the bot "Researcher" has 1 turn queued
    And the bot "Writer" has 0 turns queued
    And the external channel of "sam@example.com" in "Anthus Labs" has the bots "Researcher" and "Writer" as participants

  Scenario: A blind copy reaches the bot through the envelope recipient
    When an email arrives:
      | from    | sam.sender@example.test                          |
      | to      | colleague@example.test                           |
      | bcc     | researcher@anthus.mail.develop.example.test      |
      | subject | Quietly looping you in                           |
      | id      | bcc-1@mail.example.test                          |
      | body    | Please read this thread                          |
    Then the message was admitted
    And the bot "Researcher" has 1 turn queued

  Scenario: Address case and display names do not change which bot is addressed
    When an email arrives:
      | from    | sam.sender@example.test                          |
      | to      | "Research Bot" <RESEARCHER AT Anthus.Mail.Develop.Example.Test> |
      | subject | Shouting                                         |
      | id      | caps-1@mail.example.test                         |
      | body    | Hello                                            |
    Then the message was admitted
    And the bot "Researcher" has 1 turn queued

  Scenario: The sender is the From address and never Reply-To
    When an email arrives:
      | from     | sam.sender@example.test                         |
      | to       | researcher@anthus.mail.develop.example.test     |
      | reply-to | ada.sender@example.test                         |
      | subject  | Who am I                                        |
      | id       | replyto-1@mail.example.test                     |
      | body     | I am Sam                                        |
    Then the message was admitted
    And the parsed email is from "sam.sender@example.test" with no display name
    And "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And "ada@example.com" has 0 channels of kind "external" in "Anthus Labs"

  Scenario: A quoted earlier reply with its attribution line is stripped
    When this raw email arrives:
      """
      From: Sam Sender <sam.sender@example.test>
      To: researcher@anthus.mail.develop.example.test
      Subject: Re: Quarterly plan
      Message-ID: <reply-1@mail.example.test>
      In-Reply-To: <root-1@mail.example.test>
      Content-Type: text/plain; charset=utf-8

      Yes, start with the budget.

      On Mon, 26 Oct 2026 at 09:00, Researcher <researcher@anthus.mail.develop.example.test> wrote:
      > Where do we start?
      >
      > I can draft an outline first.
      """
    Then the message was admitted
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" reads "Yes, start with the budget."

  Scenario: A quoted block with an attribution wrapped over two lines is stripped
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Re: Quarterly plan
      Message-ID: <reply-1@mail.example.test>
      Content-Type: text/plain; charset=utf-8

      Sounds good.

      On Mon, 26 Oct 2026 at 09:00, Researcher
      <researcher@anthus.mail.develop.example.test> wrote:

      > Shall we start?
      """
    Then the message was admitted
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" reads "Sounds good."

  Scenario: An Outlook original-message block is stripped
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: RE: Quarterly plan
      Message-ID: <reply-1@mail.example.test>
      Content-Type: text/plain; charset=utf-8

      Approved.

      -----Original Message-----
      From: Researcher
      Sent: Monday, October 26, 2026 9:00 AM
      To: Sam Sender
      Subject: Quarterly plan

      Here is the outline.
      """
    Then the message was admitted
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" reads "Approved."

  Scenario: A standard signature is stripped
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Quarterly plan
      Message-ID: <root-1@mail.example.test>
      Content-Type: text/plain; charset=utf-8

      Please summarize the outline.

      -- 
      Sam Sender
      Anthus Labs
      """
    Then the message was admitted
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" reads "Please summarize the outline."

  Scenario: An inline reply keeps every word the sender wrote
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Re: Questions
      Message-ID: <reply-1@mail.example.test>
      Content-Type: text/plain; charset=utf-8

      On Mon, 26 Oct 2026 at 09:00, Researcher wrote:
      > Question one?

      Answer one.

      > Question two?

      Answer two.
      """
    Then the message was admitted
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" contains "Answer one."
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" contains "Answer two."
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" contains "Question two?"

  Scenario: A message that is only a quote is kept whole
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Fwd: Outline
      Message-ID: <fwd-1@mail.example.test>
      Content-Type: text/plain; charset=utf-8

      > Here is the outline.
      > Step one, step two.
      """
    Then the message was admitted
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" contains "Step one, step two."

  Scenario: An HTML-only mail becomes readable text and nothing remote is fetched
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Newsletter style
      Message-ID: <html-1@mail.example.test>
      Content-Type: text/html; charset=utf-8

      <html><head><style>p { color: red }</style><script>alert(1)</script></head>
      <body><p>Hello <b>team</b> &amp; friends,</p>
      <p>Read <a href="https://docs.example.test/outline">the outline</a> today.</p>
      <ul><li>First</li><li>Second</li></ul>
      <img src="https://tracker.example.test/pixel.gif" width="1" height="1">
      <img src="https://images.example.test/logo.png" alt="Logo"></body></html>
      """
    Then the message was admitted
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" contains "Hello team & friends,"
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" contains "the outline (https://docs.example.test/outline)"
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" contains "First"
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" does not contain "tracker.example.test"
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" does not contain "alert"
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" does not contain "color: red"
    And no remote content was fetched

  Scenario: The plain text part wins over the HTML part of the same message
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Both parts
      Message-ID: <alt-1@mail.example.test>
      MIME-Version: 1.0
      Content-Type: multipart/alternative; boundary="b1"

      --b1
      Content-Type: text/plain; charset=utf-8

      The plain version.
      --b1
      Content-Type: text/html; charset=utf-8

      <p>The <i>html</i> version.</p>
      --b1--
      """
    Then the message was admitted
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" reads "The plain version."

  Scenario: A long body is cut at 100 KB and says so
    When an email arrives with a body of 150000 characters:
      | from    | sam.sender@example.test                          |
      | to      | researcher@anthus.mail.develop.example.test      |
      | subject | A very long message                              |
      | id      | long-1@mail.example.test                         |
    Then the message was admitted
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" has at most 100200 characters and ends with "the full original message is kept in the raw mail archive.]"

  Scenario: Attachments are recorded as metadata and nothing is stored
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: The report
      Message-ID: <attach-1@mail.example.test>
      MIME-Version: 1.0
      Content-Type: multipart/mixed; boundary="b1"

      --b1
      Content-Type: text/plain; charset=utf-8

      The report is attached.
      --b1
      Content-Type: application/pdf; name="report.pdf"
      Content-Disposition: attachment; filename="report.pdf"
      Content-Transfer-Encoding: base64

      JVBERi0xLjQK
      --b1--
      """
    Then the message was admitted
    And the parsed email lists the attachment "report.pdf" of type "application/pdf" with 9 bytes and no storage key
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" reads "The report is attached."

  Scenario: A message that is only an attachment is still readable
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Just the file
      Message-ID: <attach-2@mail.example.test>
      MIME-Version: 1.0
      Content-Type: multipart/mixed; boundary="b1"

      --b1
      Content-Type: text/csv; name="numbers.csv"
      Content-Disposition: attachment; filename="numbers.csv"

      a,b
      1,2
      --b1--
      """
    Then the message was admitted
    And the parsed email lists the attachment "numbers.csv" of type "text/csv" with 8 bytes and no storage key
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" reads "(This message has no text.)"

  Scenario Outline: Headers that mark mail as automated drop it before any bot sees it
    When an email arrives:
      | from    | sam.sender@example.test                          |
      | to      | researcher@anthus.mail.develop.example.test      |
      | subject | Automatic reply                                  |
      | id      | auto-1@mail.example.test                         |
      | body    | I am out of the office                           |
      | headers | <header>                                         |
    Then the message was dropped as "automated_message"
    And the bot "Researcher" has 0 turns queued
    And the parsed email carries the automation hint "<hint>"

    Examples:
      | header                                 | hint          |
      | Auto-Submitted: auto-replied           | autoSubmitted |
      | Auto-Submitted: auto-generated; reason=x | autoSubmitted |
      | X-Autoreply: yes                       | autoSubmitted |
      | X-Auto-Response-Suppress: All          | autoSubmitted |
      | Return-Path: <>                        | bounceReport  |
      | X-Chatticus-Origin: development        | ownOrigin     |

  Scenario: Auto-Submitted no is an ordinary message
    When an email arrives:
      | from    | sam.sender@example.test                          |
      | to      | researcher@anthus.mail.develop.example.test      |
      | subject | Typed by a person                                |
      | id      | human-1@mail.example.test                        |
      | body    | Hello                                            |
      | headers | Auto-Submitted: no                               |
    Then the message was admitted

  Scenario: A delivery status report is dropped as a bounce
    When this raw email arrives:
      """
      From: Mail Delivery System <mailer-daemon@example.test>
      To: researcher@anthus.mail.develop.example.test
      Subject: Undelivered Mail Returned to Sender
      Message-ID: <bounce-1@mail.example.test>
      MIME-Version: 1.0
      Content-Type: multipart/report; report-type=delivery-status; boundary="b1"

      --b1
      Content-Type: text/plain; charset=utf-8

      Your message could not be delivered.
      --b1
      Content-Type: message/delivery-status

      Reporting-MTA: dns; mail.example.test
      --b1--
      """
    Then the parsed email carries the automation hint "bounceReport"
    And the bot "Researcher" has 0 turns queued

  Scenario: Mailing list mail is marked as list mail and bulk mail is marked as bulk
    When an email arrives:
      | from    | sam.sender@example.test                          |
      | to      | researcher@anthus.mail.develop.example.test      |
      | subject | Digest                                           |
      | id      | list-1@mail.example.test                         |
      | body    | This week                                        |
      | headers | List-Id: <weekly.example.test> ;; Precedence: bulk |
    Then the parsed email carries the automation hint "listMail"
    And the parsed email carries the automation hint "bulkPrecedence"

  Scenario Outline: Mail whose sender or content the receiver could not vouch for is refused and counted
    Given the next email carries the verdicts:
      | spf   | <spf>   |
      | dkim  | <dkim>  |
      | dmarc | <dmarc> |
      | spam  | <spam>  |
      | virus | <virus> |
    When an email arrives:
      | from    | sam.sender@example.test                          |
      | to      | researcher@anthus.mail.develop.example.test      |
      | subject | Quarterly plan                                   |
      | id      | verdict-1@mail.example.test                      |
      | body    | Please research this                             |
    Then the email was refused as "<reason>"
    And the counter "inbound_refused" was counted 1 time
    And "sam@example.com" has 0 channels of kind "external" in "Anthus Labs"
    And the bot "Researcher" has 0 turns queued

    Examples:
      | spf  | dkim | dmarc | spam | virus | reason                  |
      | PASS | PASS | FAIL  | PASS | PASS  | sender_not_authenticated |
      | PASS | PASS | GRAY  | PASS | PASS  | sender_not_authenticated |
      | PASS | PASS | PASS  | FAIL | PASS  | spam_or_virus_detected  |
      | PASS | PASS | PASS  | PASS | FAIL  | spam_or_virus_detected  |

  Scenario: A sender who passes DMARC but is not linked is dropped
    When an email arrives:
      | from    | stranger@example.test                            |
      | to      | researcher@anthus.mail.develop.example.test      |
      | subject | Hello                                            |
      | id      | stranger-1@mail.example.test                     |
      | body    | Who is this bot?                                 |
    Then the message was dropped as "unlinked_sender"

  Scenario: Mail for an address nobody bound is counted and stores nothing
    Given the Messaging table is counted
    When an email arrives:
      | from    | sam.sender@example.test                          |
      | to      | nobody@anthus.mail.develop.example.test          |
      | subject | Anyone there                                     |
      | id      | nobody-1@mail.example.test                       |
      | body    | Hello                                            |
    Then the message was dropped as "unknown_route"
    And the Messaging table holds the same items as when it was counted
    And the counter "inbound_unknown_route" was counted 1 time

  Scenario: A message in a Latin-1 charset is read correctly
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: =?ISO-8859-1?Q?Caf=E9?=
      Message-ID: <latin-1@mail.example.test>
      MIME-Version: 1.0
      Content-Type: text/plain; charset=iso-8859-1
      Content-Transfer-Encoding: quoted-printable

      Un caf=E9, s'il vous pla=EEt.
      """
    Then the message was admitted
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" reads "Un café, s'il vous plaît."

  Scenario: A charset nobody knows does not crash the ingress
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Odd charset
      Message-ID: <odd-1@mail.example.test>
      MIME-Version: 1.0
      Content-Type: text/plain; charset=x-no-such-charset

      Plain words survive.
      """
    Then the message was admitted
    And the counter "inbound_charset_fallback" was counted 1 time
    And the latest message on the external channel of "sam@example.com" in "Anthus Labs" contains "Plain words survive."

  Scenario Outline: Malformed mail is refused and counted and never throws
    Given the Messaging table is counted
    When this raw email arrives:
      """
      <raw>
      """
    Then the email was refused as "<reason>"
    And the counter "inbound_refused" was counted 1 time
    And the Messaging table holds the same items as when it was counted

    Examples:
      | raw                                  | reason            |
      | this is not an email at all          | malformed_message |
      | Subject: no sender at all            | malformed_message |

  Scenario: A message with no Message-ID is refused and counted
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: No id
      Content-Type: text/plain; charset=utf-8

      Where is my id?
      """
    Then the email was refused as "missing_message_id"
    And the counter "inbound_refused" was counted 1 time

  Scenario: A message over the size limit is refused before it is parsed
    When a raw email of 41 megabytes arrives
    Then the email was refused as "message_too_large"
    And the counter "inbound_refused" was counted 1 time

  Scenario Outline: Hostile HTML cannot hold a worker
    When an HTML email made of 60000 repeats of "<fragment>" arrives
    Then the email was processed within 2 seconds

    Examples:
      | fragment       |
      | <script{space}      |
      | <!--                |
      | <a{space}href=x>    |
      | <blockquote>        |
      | <                   |

  Scenario: A header with tens of thousands of encoded words is refused fast and counted
    When a raw email with a subject of 40000 encoded words arrives
    Then the email was refused as "malformed_message"
    And the email was processed within 2 seconds
    And the counter "inbound_refused" was counted 1 time

  Scenario: A message with two From headers is refused as malformed
    When this raw email arrives:
      """
      From: sam.sender@example.test
      From: ada.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Whose message is this
      Message-ID: <two-from-1@mail.example.test>
      Content-Type: text/plain; charset=utf-8

      Pick a sender.
      """
    Then the email was refused as "malformed_message"
    And the counter "inbound_refused" was counted 1 time

  Scenario: A From header with two mailboxes is refused as malformed
    When this raw email arrives:
      """
      From: sam.sender@example.test, ada.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Two people
      Message-ID: <two-box-1@mail.example.test>
      Content-Type: text/plain; charset=utf-8

      Pick a sender.
      """
    Then the email was refused as "malformed_message"
    And the counter "inbound_refused" was counted 1 time

  Scenario: A From header in group syntax is refused as malformed
    When this raw email arrives:
      """
      From: Team: sam.sender@example.test;
      To: researcher@anthus.mail.develop.example.test
      Subject: A group
      Message-ID: <group-1@mail.example.test>
      Content-Type: text/plain; charset=utf-8

      Groups are not senders.
      """
    Then the email was refused as "malformed_message"
    And the counter "inbound_refused" was counted 1 time

  Scenario: A verdict header written inside the message proves nothing
    Given the next email carries the verdicts:
      | spf   | PASS |
      | dkim  | PASS |
      | dmarc | FAIL |
      | spam  | PASS |
      | virus | PASS |
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: Trust me
      Message-ID: <forged-1@mail.example.test>
      X-Inbound-Dmarc-Verdict: PASS
      Content-Type: text/plain; charset=utf-8

      My own header says I passed.
      """
    Then the email was refused as "sender_not_authenticated"
    And the bot "Researcher" has 0 turns queued

  Scenario: The envelope recipient decides which bot is addressed, not the To header
    When an email arrives:
      | from     | sam.sender@example.test                          |
      | to       | writer@anthus.mail.develop.example.test          |
      | envelope | researcher@anthus.mail.develop.example.test      |
      | subject  | Written for one, delivered to the other          |
      | id       | envelope-1@mail.example.test                     |
      | body     | Who gets this                                    |
    Then the message was admitted
    And the bot "Researcher" has 1 turn queued
    And the bot "Writer" has 0 turns queued

  Scenario: Attachment names and types are cleaned at the boundary
    When this raw email arrives:
      """
      From: sam.sender@example.test
      To: researcher@anthus.mail.develop.example.test
      Subject: A hostile name
      Message-ID: <attach-3@mail.example.test>
      MIME-Version: 1.0
      Content-Type: multipart/mixed; boundary="b1"

      --b1
      Content-Type: text/plain; charset=utf-8

      See the file.
      --b1
      Content-Type: text/plain; name="x"
      Content-Disposition: attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpass%00wd%0A

      data
      --b1--
      """
    Then the message was admitted
    And the parsed email lists the attachment "passwd" of type "text/plain" with 4 bytes and no storage key
