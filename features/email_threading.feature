Feature: An email thread is one Chatticus channel
  As a member who talks to a bot by email
  I want every reply in a thread to land in the same channel, whatever my mail client did to the headers
  So that the web app shows one conversation per thread, and so that nothing but my own authenticated mail can reach it

  The conversation of an email is found from the headers the mail client sent. The thread root is the first message id in
  References, else In-Reply-To, else the message's own id, and every earlier message id the reply mentions is looked up as
  well, so a client that strips References still lands in the right channel. The subject never decides anything. A plus tag
  on the bot address is a fallback hint that must match a keyed hash of one of the sender's own channels; it never
  authorizes anything, and a tag that does not match is ignored. A reference nobody knows starts a new channel. The
  contract is docs/EXTERNAL_CHANNELS.md.

  Background:
    Given an empty control plane
    And external channels are configured for this environment with the mail domain "mail.develop.example.test"
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Anthus Labs" has the bot "Researcher"
    And external channels are switched on for the organization "Anthus Labs"
    And "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And "ryan@example.com" has created an email binding for the bot "Researcher" in "Anthus Labs"
    And the email sender "sam.sender@example.test" is linked to "sam@example.com" in "Anthus Labs"
    And the email sender "ada.sender@example.test" is linked to "ada@example.com" in "Anthus Labs"

  Scenario: The first mail of a thread opens one channel named from its subject and the reply lands in it
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Quarterly plan                                   |
      | id          | root-1@mail.example.test                         |
      | body        | Where do we start?                               |
    And an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Re: Quarterly plan                               |
      | id          | reply-1@mail.example.test                        |
      | in-reply-to | root-1@mail.example.test                         |
      | references  | root-1@mail.example.test                         |
      | body        | And the budget?                                  |
    Then "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And the external channel of "sam@example.com" in "Anthus Labs" is named "Quarterly plan"
    And that channel has 2 messages

  Scenario: A reply that quotes an earlier message id lands in the same channel even when References is stripped
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Quarterly plan                                   |
      | id          | root-1@mail.example.test                         |
      | body        | Where do we start?                               |
    And an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Re: Quarterly plan                               |
      | id          | reply-1@mail.example.test                        |
      | in-reply-to | root-1@mail.example.test                         |
      | references  | root-1@mail.example.test                         |
      | body        | And the budget?                                  |
    And an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Re: Quarterly plan                               |
      | id          | reply-2@mail.example.test                        |
      | in-reply-to | reply-1@mail.example.test                        |
      | body        | And the schedule?                                |
    Then "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And that channel has 3 messages

  Scenario: A reply whose mail client lowercased or reshaped the message ids still finds the thread
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Quarterly plan                                   |
      | id          | Root-1 AT Mail.Example.Test                         |
      | body        | Where do we start?                               |
    And an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Re: Quarterly plan                               |
      | id          | reply-1@mail.example.test                        |
      | in-reply-to | root-1@mail.example.test                         |
      | body        | And the budget?                                  |
    Then "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And that channel has 2 messages

  Scenario: A changed subject does not split a thread
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Quarterly plan                                   |
      | id          | root-1@mail.example.test                         |
      | body        | Where do we start?                               |
    And an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Something else entirely                          |
      | id          | reply-1@mail.example.test                        |
      | in-reply-to | root-1@mail.example.test                         |
      | references  | root-1@mail.example.test                         |
      | body        | New subject, same thread                         |
    Then "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And the external channel of "sam@example.com" in "Anthus Labs" is named "Quarterly plan"
    And that channel has 2 messages

  Scenario: A reference nobody knows starts a new channel
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Quarterly plan                                   |
      | id          | root-1@mail.example.test                         |
      | body        | Where do we start?                               |
    And an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Re: Something from another mailbox               |
      | id          | other-1@mail.example.test                        |
      | in-reply-to | never-seen@mail.example.test                     |
      | references  | never-seen@mail.example.test                     |
      | body        | Continuing a thread we never saw                 |
    Then "sam@example.com" has 2 channels of kind "external" in "Anthus Labs"

  Scenario: Two unrelated mails open two channels
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | First topic                                      |
      | id          | one@mail.example.test                            |
      | body        | First                                            |
    And an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Second topic                                     |
      | id          | two@mail.example.test                            |
      | body        | Second                                           |
    Then "sam@example.com" has 2 channels of kind "external" in "Anthus Labs"

  Scenario: The same mail delivered twice is one message
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Quarterly plan                                   |
      | id          | root-1@mail.example.test                         |
      | body        | Where do we start?                               |
    And the same email request is delivered 2 more times
    Then the message was admitted as a duplicate of the first one
    And "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And that channel has 1 message

  Scenario: A valid plus tag finds the thread when a mail client strips every threading header
    Given an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Quarterly plan                                   |
      | id          | root-1@mail.example.test                         |
      | body        | Where do we start?                               |
    And the plus tag of the external channel of "sam@example.com" in "Anthus Labs" is known
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher+{tag}@anthus.mail.develop.example.test |
      | subject     | A fresh message with no headers                  |
      | id          | stripped-1@mail.example.test                     |
      | body        | I replied from a client that drops headers       |
    Then "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And that channel has 2 messages

  Scenario: A plus tag with a bad hash still routes by the headers
    Given an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Quarterly plan                                   |
      | id          | root-1@mail.example.test                         |
      | body        | Where do we start?                               |
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher+forgedtag@anthus.mail.develop.example.test |
      | subject     | Re: Quarterly plan                               |
      | id          | reply-1@mail.example.test                        |
      | in-reply-to | root-1@mail.example.test                         |
      | body        | The headers are intact                           |
    Then "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And that channel has 2 messages

  Scenario: A plus tag with a bad hash and no headers starts a new thread
    Given an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Quarterly plan                                   |
      | id          | root-1@mail.example.test                         |
      | body        | Where do we start?                               |
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher+forgedtag@anthus.mail.develop.example.test |
      | subject     | Looks like a reply                               |
      | id          | guess-1@mail.example.test                        |
      | body        | I guessed a tag                                  |
    Then the message was admitted
    And "sam@example.com" has 2 channels of kind "external" in "Anthus Labs"

  Scenario: A valid plus tag of someone else's thread gives a sender no access to it
    Given an email arrives:
      | from        | ada.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Ada's private plan                               |
      | id          | ada-root@mail.example.test                       |
      | body        | A thread that belongs to Ada                     |
    And the plus tag of the external channel of "ada@example.com" in "Anthus Labs" is known
    When an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher+{tag}@anthus.mail.develop.example.test |
      | subject     | Trying a copied tag                              |
      | id          | sam-1@mail.example.test                          |
      | body        | I copied the tag from a forwarded mail           |
    Then the message was admitted
    And "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And "ada@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And that channel has 1 message

  Scenario: A valid plus tag does not make an unlinked sender a member
    Given an email arrives:
      | from        | sam.sender@example.test                          |
      | to          | researcher@anthus.mail.develop.example.test      |
      | subject     | Quarterly plan                                   |
      | id          | root-1@mail.example.test                         |
      | body        | Where do we start?                               |
    And the plus tag of the external channel of "sam@example.com" in "Anthus Labs" is known
    When an email arrives:
      | from        | stranger@example.test                            |
      | to          | researcher+{tag}@anthus.mail.develop.example.test |
      | subject     | Quarterly plan                                   |
      | id          | stranger-1@mail.example.test                     |
      | body        | I have the tag                                   |
    Then the message was dropped as "unlinked_sender"
    And "sam@example.com" has 1 channel of kind "external" in "Anthus Labs"
    And that channel has 1 message
