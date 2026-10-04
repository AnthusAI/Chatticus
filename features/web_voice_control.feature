Feature: Talking to teammates by voice
  As an organization member running work from the workspace
  I want to speak to my teammates by name while the microphone listens
  So that I can direct work hands-free without paying for a live audio stream

  Listening, transcription and routing happen in the browser. A heard line
  leaves the browser only when it is addressed to a teammate, and then it is
  an ordinary message that starts an ordinary turn.

  Background:
    Given the voice workspace has teammates "Ada" and "Grace"

  Scenario: A line that starts with a teammate's name becomes a message to that teammate
    When the member says "Ada, open a pull request for the voice spike."
    Then a message "Open a pull request for the voice spike." is sent to "Ada"
    And it goes to the direct conversation with "Ada"

  Scenario: An addressed line stays in the open named channel when the teammate is in it
    Given the named channel "Release" with "Ada" and "Grace" is open
    When the member says "Grace, what is the status of the release branch?"
    Then a message "What is the status of the release branch?" is sent to "Grace"
    And it goes to the named channel "Release"

  Scenario: A misheard name still reaches the teammate when it is spoken as an address
    When the member says "Grays, run the behave suite."
    Then a message "Run the behave suite." is sent to "Grace"

  Scenario: Ordinary words that sound like a name are not an address
    When the member says "Add the tests to the branch."
    Then nothing leaves the browser

  Scenario: A teammate's name used as an ordinary word is not an address
    When the member says "Grace period ends on Friday."
    Then nothing leaves the browser

  Scenario: A word that only roughly sounds like a name is not an address
    When the member says "Gross, I spilled my coffee."
    Then nothing leaves the browser

  Scenario: Speech that is not addressed to a teammate never leaves the browser
    When the member says "I think we should get lunch after this meeting."
    Then nothing leaves the browser

  Scenario: Switching teammates by voice selects the teammate without sending a message
    When the member says "Switch to Grace."
    Then "Grace" is selected
    And no message is sent

  Scenario: Saying only a teammate's name opens the conversation with that teammate
    When the member says "Ada."
    Then "Ada" is selected
    And no message is sent

  Scenario: Saying stop listening turns the microphone off
    When the member says "Stop listening, please."
    Then listening stops
    And no message is sent

  Scenario: A line addressed to a teammate who is already working waits for the member
    Given "Ada" is already working on a turn in the direct conversation
    When the member says "Ada, also update the changelog."
    Then no message is sent
    And the member is told "Ada is still working. Say it again when Ada is done."

  Scenario: Voice listening needs a cross-origin isolated page
    Given the page is not cross-origin isolated
    When the member asks to start listening
    Then listening is unavailable because "Voice needs this page to be cross-origin isolated."

  Scenario: Voice listening needs a microphone
    Given the browser offers no microphone
    When the member asks to start listening
    Then listening is unavailable because "This browser does not offer a microphone."

  Scenario: A teammate's reply is spoken when their turn ends while listening
    Given voice listening is on
    When "Ada" replies "The pull request is open."
    Then the browser says "Ada says: The pull request is open."

  Scenario: Nothing is spoken while listening is off
    Given voice listening is off
    When "Ada" replies "The pull request is open."
    Then the browser says nothing

  Scenario: The spoken reply is the teammate's own answer to that turn
    Given voice listening is on
    And the member asked "Ada" "Status?" in a channel where "Grace" also answered "Nothing new."
    When the turn for "Ada" ends with Ada's answer "All green."
    Then the browser says "Ada says: All green."

  Scenario Outline: Formatting, links and code are spoken as plain words
    Given voice listening is on
    When "Ada" replies "<reply>"
    Then the browser says "<spoken>"

    Examples:
      | reply                                                                                 | spoken                                                           |
      | **Done.** See https://github.com/AnthusAI/Chatticus/pull/388 and run `npm test`.      | Ada says: Done. See the link on screen and run npm test.         |
      | - Opened [the pull request](https://example.com/pr/1).\n- Ran the tests.              | Ada says: Opened the pull request. Ran the tests.                |
      | Run this:\n```bash\nnpm test\n```\nThen tell me.                                      | Ada says: Run this: the code on screen. Then tell me.            |
      | Renamed `my_test_file` to my_test_file_two.                                           | Ada says: Renamed my_test_file to my_test_file_two.              |
      | Version 1.2 is out.                                                                   | Ada says: Version 1.2 is out.                                    |
      | Merged (see https://example.com/pr/2).                                                | Ada says: Merged (see the link on screen).                       |
      | Here:\n```bash\nnpm test                                                              | Ada says: Here: the code on screen.                              |

  Scenario: A long reply is cut short with a pointer to the screen
    Given voice listening is on
    When "Ada" replies with a reply of 12 sentences
    Then the browser says only the first sentences of the reply
    And the browser ends with "The rest is on screen."

  Scenario: A failed turn's reason is spoken
    Given voice listening is on
    When the turn for "Ada" fails with reason "The model provider rejected the API key."
    Then the browser says "Ada could not answer. The model provider rejected the API key."

  Scenario: Saying stop while a reply is being spoken stops speaking
    Given a reply is being spoken
    When the member says "Stop."
    Then speaking stops
    And no message is sent

  Scenario: While a reply is being spoken, other speech is ignored
    Given a reply is being spoken
    When the member says "Ada, open a pull request for the voice spike."
    Then nothing leaves the browser

  Scenario: The tail of a spoken reply heard after it ends is not acted on
    Given a line began while a reply was being spoken
    When the member says "Grace, please review the release branch."
    Then nothing leaves the browser
