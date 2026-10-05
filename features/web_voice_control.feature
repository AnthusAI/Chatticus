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

  Scenario: A line said while the teammate is working is queued and sent when the turn ends
    Given the direct conversation with "Ada" is open
    And "Ada" is already working on a turn in the direct conversation
    When the member says "also update the changelog" to the open conversation
    Then nothing has been sent yet
    And the member is told 'Will send when Ada is done: "also update the changelog"'
    And nothing is spoken aloud
    When "Ada" finishes the turn
    Then these messages were sent to "Ada" in order:
      | message |
      | also update the changelog |

  Scenario: Several lines said while the teammate is working are delivered in order as one message
    Given the direct conversation with "Ada" is open
    And "Ada" is already working on a turn in the direct conversation
    When the member says "check the build logs" to the open conversation
    And the member says "then restart the worker" to the open conversation
    Then the member is told 'Will send when Ada is done: "check the build logs then restart the worker"'
    When "Ada" finishes the turn
    Then these messages were sent to "Ada" in order:
      | message |
      | check the build logs then restart the worker |

  Scenario: Queued lines are dropped, and the member is told, when the conversation changes
    Given the direct conversation with "Ada" is open
    And "Ada" is already working on a turn in the direct conversation
    When the member says "also update the changelog" to the open conversation
    And the member switches to another conversation
    Then the member is told "1 unsent line was dropped because you switched conversations."
    When "Ada" finishes the turn
    Then nothing has been sent yet

  Scenario: A line said while the teammate is idle is sent at once
    Given the direct conversation with "Ada" is open
    When the member says "open the pull request" to the open conversation
    Then these messages were sent to "Ada" in order:
      | message |
      | open the pull request |
    And nothing is spoken aloud

  Scenario: A speaking state that is stuck does not discard later lines
    Given the direct conversation with "Ada" is open
    And a reply is flagged as speaking although the speech engine has been idle for 1500 milliseconds past its expected end
    When the member says "now merge the pull request" to the open conversation
    Then the line is not mistaken for the browser hearing itself
    And these messages were sent to "Ada" in order:
      | message |
      | now merge the pull request |

  Scenario: A reply still sounding past its expected end still guards against the browser hearing itself
    Given the direct conversation with "Ada" is open
    And a reply is flagged as speaking and the speech engine is still producing it past its expected end
    When the member says "now merge the pull request" to the open conversation
    Then the line is mistaken for the browser hearing itself

  Scenario: A line that could not be sent is spoken aloud
    Given the direct conversation with "Ada" is open
    And sending to the teammate fails
    When the member says "ship it now" to the open conversation
    Then the browser says "Couldn't send that."

  Scenario: A line the server found no message in is spoken aloud
    Given the direct conversation with "Ada" is open
    And the server finds no message in what was heard
    When the member says "um so yeah" to the open conversation
    Then the browser says "Didn't catch a message there."

  Scenario: A line that could not be checked against the teammate is spoken aloud
    Given the direct conversation with "Ada" is open
    And the teammate's status cannot be checked
    When the member says "ship it now" to the open conversation
    Then the browser says "Couldn't send that."

  Scenario: A line discarded as an echo while no reply is playing is spoken aloud
    Given the direct conversation with "Ada" is open
    When the member says "the pull request is open" to the open conversation just after a reply ended
    Then nothing has been sent yet
    And the browser says "Ignored that as an echo. Say it again."

  Scenario: Echo feedback heard back does not trigger more feedback
    Given the direct conversation with "Ada" is open
    When the member says "the pull request is open" to the open conversation just after a reply ended
    And the member says "Say it again" to the open conversation just after a reply ended
    Then the browser said "Ignored that as an echo. Say it again." exactly once
    When 11 seconds go by in the voice session
    And the member says "the pull request is open" to the open conversation just after a reply ended
    Then the browser said "Ignored that as an echo. Say it again." 2 times

  Scenario: A failed send keeps the line and retries it with the next line
    Given the direct conversation with "Ada" is open
    And sending to the teammate fails once and then recovers
    When the member says "ship it now" to the open conversation
    Then the browser says "Couldn't send that."
    When the member says "and tag the release" to the open conversation
    Then these messages were sent to "Ada" in order:
      | message |
      | ship it now |
      | ship it now and tag the release |

  Scenario: Echo feedback followed by a send failure still speaks the failure
    Given the direct conversation with "Ada" is open
    And sending to the teammate fails
    When the member says "the pull request is open" to the open conversation just after a reply ended
    And 3 seconds go by in the voice session
    And the member says "ship it now" to the open conversation
    Then the browser said "Ignored that as an echo. Say it again." exactly once
    And the browser said "Couldn't send that." exactly once

  Scenario: Send-failure feedback during a reply is spoken after the reply ends
    Given the direct conversation with "Ada" is open
    And sending to the teammate fails
    And a reply is being spoken
    When the member says "ship it now" to the open conversation
    Then nothing is spoken aloud
    When the reply ends
    Then the browser said "Couldn't send that." exactly once

  Scenario: A parked failure retries on its own after 5 seconds
    Given the direct conversation with "Ada" is open
    And sending to the teammate fails once and then recovers
    When the member says "ship it now" to the open conversation
    And 4 seconds go by in the voice session
    Then these messages were sent to "Ada" in order:
      | message |
      | ship it now |
    When 1 seconds go by in the voice session
    Then these messages were sent to "Ada" in order:
      | message |
      | ship it now |
      | ship it now |

  Scenario: With the server down the failure is spoken once and retried once
    Given the direct conversation with "Ada" is open
    And sending to the teammate keeps failing
    When the member says "ship it now" to the open conversation
    And 5 seconds go by in the voice session
    And 30 seconds go by in the voice session
    Then these messages were sent to "Ada" in order:
      | message |
      | ship it now |
      | ship it now |
    And the browser said "Couldn't send that." exactly once

  Scenario: Several notices that waited for a reply are spoken together once
    Given the direct conversation with "Ada" is open
    And sending to the teammate fails
    And a reply is being spoken
    When the member says "ship it now" to the open conversation
    And the member says "ship it again" to the open conversation
    And the reply ends
    Then the browser said "Couldn't send that." exactly once

  Scenario: A line heard with no conversation open is spoken aloud
    When the member says "hello there" to the open conversation
    Then the browser says "Open a conversation first."

  Scenario: Spoken feedback never talks over a reply
    Given the direct conversation with "Ada" is open
    And sending to the teammate fails
    And a reply is being spoken
    When the member says "ship it now" to the open conversation
    Then nothing is spoken aloud

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
    Then the browser says "The pull request is open."

  Scenario: Only the reply is spoken, never the teammate's name
    Given voice listening is on
    When "Grace" replies "Nothing new."
    Then the browser says "Nothing new."

  Scenario: Nothing is spoken while listening is off
    Given voice listening is off
    When "Ada" replies "The pull request is open."
    Then the browser says nothing

  Scenario: The spoken reply is the teammate's own answer to that turn
    Given voice listening is on
    And the member asked "Ada" "Status?" in a channel where "Grace" also answered "Nothing new."
    When the turn for "Ada" ends with Ada's answer "All green."
    Then the browser says "All green."

  Scenario Outline: Formatting, links and code are spoken as plain words
    Given voice listening is on
    When "Ada" replies "<reply>"
    Then the browser says "<spoken>"

    Examples:
      | reply                                                                                 | spoken                                                           |
      | **Done.** See https://github.com/AnthusAI/Chatticus/pull/388 and run `npm test`.      | Done. See the link on screen and run npm test.         |
      | - Opened [the pull request](https://example.com/pr/1).\n- Ran the tests.              | Opened the pull request. Ran the tests.                |
      | Run this:\n```bash\nnpm test\n```\nThen tell me.                                      | Run this: the code on screen. Then tell me.            |
      | Renamed `my_test_file` to my_test_file_two.                                           | Renamed my_test_file to my_test_file_two.              |
      | Version 1.2 is out.                                                                   | Version 1.2 is out.                                    |
      | Merged (see https://example.com/pr/2).                                                | Merged (see the link on screen).                       |
      | Here:\n```bash\nnpm test                                                              | Here: the code on screen.                              |

  Scenario: A long reply is cut short with a pointer to the screen
    Given voice listening is on
    When "Ada" replies with a reply of 12 sentences
    Then the browser says only the first sentences of the reply
    And the browser ends with "The rest is on screen."

  Scenario: A failed turn's reason is spoken
    Given voice listening is on
    When the turn for "Ada" fails with reason "The model provider rejected the API key."
    Then the browser says "That did not work. The model provider rejected the API key."

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

  Scenario: After a spoken reply ends, the next line goes to the same teammate
    Given the direct conversation with "Ada" is open
    And "Ada" replied "The pull request is open.", which was spoken from 0 seconds to 8 seconds
    When the member speaks "now merge it" for 2 seconds, finishing 12 seconds in
    Then "now merge it" is sent to "Ada" for understanding

  Scenario: A reply whose end is never reported stops blocking the member after its expected length
    Given the direct conversation with "Ada" is open
    And "Ada" replied "The pull request is open.", which was spoken but never reported finishing
    When the member speaks "now merge it" for 2 seconds, finishing 40 seconds in
    Then "now merge it" is sent to "Ada" for understanding

  Scenario: A reply whose end is never reported still guards against the browser hearing itself
    Given the direct conversation with "Ada" is open
    And "Ada" replied "The pull request is open.", which was spoken but never reported finishing
    When the member speaks "the pull request is open" for 2 seconds, finishing 4 seconds in
    Then nothing leaves the browser

  Scenario: A line is placed in time by the clock, not by the recognizer's own timeline
    When a line lasting 3 seconds finishes 20 seconds in
    Then the line is placed 17 seconds in

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
      | needsTap    | quiet       | AudioLines | Tap to keep talking      | alert   | not pressed |
      | error       | quiet       | AudioLines | Start voice conversation | alert   | not pressed |
      | unavailable | quiet       | AudioLines | Start voice conversation | alert   | not pressed |

  Scenario: A speech recognition hiccup does not end the voice conversation
    Given the voice session is "listening"
    When the speech recognizer reports "Decode failed on one pass."
    Then the voice session is "listening"
    And the member is told "Voice hiccup: Decode failed on one pass."

  Scenario: Capture keeps listening while a reply is being spoken
    Given a reply is being spoken
    When the capture engine runs, the microphone is live and audio arrived 100 milliseconds ago
    Then capture is left alone

  Scenario: Capture that stops delivering audio is noticed whether or not a reply is spoken
    Given a reply is being spoken
    When the capture engine runs, the microphone is live and audio arrived 2000 milliseconds ago
    Then capture is restored because "no audio is arriving"

  Scenario: A suspended capture engine is noticed
    When the capture engine is suspended, the microphone is live and audio arrived 100 milliseconds ago
    Then capture is restored because "the audio engine is suspended"

  Scenario: A muted microphone track is not treated as listening
    When the capture engine runs, the microphone is muted and audio arrived 100 milliseconds ago
    Then capture is restored because "the system muted the microphone"

  Scenario: An ended microphone track is not treated as listening
    When the capture engine runs, the microphone is ended and audio arrived 100 milliseconds ago
    Then capture is restored because "the microphone track ended"

  Scenario: Capture that comes back on its own after a wake-up says it is listening again
    When capture is restored and the engine wakes on request
    Then capture is "listening" and the member is told "Listening again."

  Scenario: Capture that does not come back is restarted from a fresh microphone stream
    When capture is restored and the engine does not wake and a restart is allowed
    Then capture is "restarted" and the member is told "Microphone restarted after speech."

  Scenario: A muted track that a wake-up does not fix is restarted
    When capture is restored and the microphone is muted and a restart is allowed
    Then capture is "restarted" and the member is told "Microphone restarted after speech."

  Scenario: When a restart needs a tap, the button asks for one and the tap resumes listening
    When capture is restored and the engine does not wake and a restart needs a tap
    Then capture is "needsTap" and the member is told "Tap to keep talking: The browser needs a tap to reopen the microphone."
    And the voice button shows the "AudioLines" icon labelled "Tap to keep talking"
    When the member taps the voice button
    Then capture is "restarted" and the member is told "Microphone restarted after speech."

  Scenario: A line heard during a reply that is not a stop command does not stop the reply
    Given a reply is being spoken
    When the member says "Please don't stop now."
    Then speaking does not stop
    And nothing leaves the browser

  Scenario: The watchdog does not end speech that has not started yet
    When the speech engine reports idle 600 milliseconds after speech was queued and nothing has started
    Then the watchdog leaves the speech running

  Scenario: The watchdog ends speech that never starts after a grace period
    When the speech engine reports idle 5000 milliseconds after speech was queued and nothing has started
    Then the watchdog ends the speech

  Scenario: The watchdog ends speech that started and then went quiet
    When the speech engine reports idle 600 milliseconds after speech was queued and speech had started
    Then the watchdog ends the speech

  Scenario: The watchdog never ends speech the engine is still producing
    When the speech engine reports busy 9000 milliseconds after speech was queued and speech had started
    Then the watchdog leaves the speech running

  Scenario: Speech that ended early says why
    When speech ends because of "deadline: the reply ran past its expected length"
    Then the browser says "Speech stopped: deadline: the reply ran past its expected length"

  Scenario: Speech that finished on its own says nothing
    When speech ends because of "finished"
    Then the browser says nothing

  Scenario: Tapping opens the microphone and audio context before any await so the tap still counts as the gesture
    When capture is restored and the engine does not wake and a restart needs a tap
    And the member taps the voice button
    Then the microphone and audio context are opened and resumed before any await

  Scenario: Capture that keeps stalling after restarts stops cycling and asks for a tap
    When capture is restored and the engine does not wake and a restart is allowed and 3 restarts already happened in the last minute
    Then capture is "needsTap" and the member is told "Tap to keep talking: the microphone keeps stalling"

  Scenario: A capture engine suspended by a spoken reply is left alone until speech ends
    Given a reply is being spoken
    When the capture engine is suspended while the reply plays and then the reply ends
    Then no resume or microphone request happens while the reply plays
    And capture recovery runs once the reply ends

  Scenario: Stalled audio frames during a spoken reply are not acted on until speech ends
    Given a reply is being spoken
    When audio stops arriving while the reply plays and then the reply ends
    Then no resume or microphone request happens while the reply plays
    And capture recovery runs once the reply ends
