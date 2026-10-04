Feature: Talking to teammates by voice
  As an organization member running work from the workspace
  I want to talk to the teammate in front of me without a wake word
  So that I can direct work hands-free, as in a conversation

  Listening and transcription happen in the browser. While listening is on,
  each line the member says goes to the teammate in the open conversation,
  after the understand-the-user step repairs it
  (features/voice_messages.feature). A few spoken commands act locally.

  Background:
    Given the voice workspace has teammates "Ada" and "Grace"

  Scenario: A line said in a teammate's conversation goes to that teammate
    Given the direct conversation with "Ada" is open
    When the member says "open a pull request for the voice spike"
    Then "open a pull request for the voice spike" is sent to "Ada" for understanding

  Scenario: In a named channel, a line goes to the teammate chosen to answer
    Given the named channel "Release" with "Ada" and "Grace" is open
    And "Grace" is chosen to answer in that channel
    When the member says "what is the status of the release branch"
    Then "what is the status of the release branch" is sent to "Grace" for understanding

  Scenario: Nothing is sent when no conversation is open
    When the member says "hello there"
    Then no message is sent
    And the member is told "Open a conversation to talk to a teammate."

  Scenario: Saying stop listening turns the microphone off
    Given the direct conversation with "Ada" is open
    When the member says "Stop listening, please."
    Then listening stops
    And no message is sent

  Scenario: A line said while the teammate is still working waits for the member
    Given the direct conversation with "Ada" is open
    And "Ada" is already working on a turn in the direct conversation
    When the member says "also update the changelog"
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

  Scenario Outline: The voice button always says what the session is doing
    When the voice session is "<phase>" and the browser is "<speech>"
    Then the voice button shows the "<icon>" icon labelled "<label>"
    And the voice button looks "<look>"
    And the voice button is "<pressed>"

    Examples:
      | phase       | speech      | icon       | label                    | look    | pressed     |
      | idle        | quiet       | AudioLines | Start voice conversation | neutral | not pressed |
      | loading     | quiet       | AudioLines | Loading voice model      | neutral | disabled    |
      | listening   | quiet       | AudioLines | End voice conversation   | active  | pressed     |
      | listening   | speaking    | AudioLines | End voice conversation   | active  | pressed     |
      | error       | quiet       | AudioLines | Start voice conversation | alert   | not pressed |
      | unavailable | quiet       | AudioLines | Start voice conversation | alert   | not pressed |

  Scenario: A speech recognition hiccup does not end the voice conversation
    Given the voice session is "listening"
    When the speech recognizer reports "Decode failed on one pass."
    Then the voice session is "listening"
    And the member is told "Voice hiccup: Decode failed on one pass."

  Scenario: Losing the microphone ends the voice conversation and says why
    Given the voice session is "listening"
    When the microphone is lost with the reason "The microphone was disconnected."
    Then the voice session is "error"
    And the member is told "The microphone was disconnected."
