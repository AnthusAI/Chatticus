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
