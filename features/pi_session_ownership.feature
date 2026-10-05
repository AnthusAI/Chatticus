Feature: Pi session ownership
  As the Chatticus control plane
  I want exactly one owner at a time to write a bot's channel session
  So that a retried or duplicated turn can never corrupt the transcript

  Scenario: An owner opens a session and commits
    Given the bot "ada" answers "Hello from Ada" to every message
    When an owner opens the session for bot "ada" in channel "general"
    And the owner sends "hello"
    Then the owner receives the answer "Hello from Ada"
    And the owner holds ownership number 1

  Scenario: A second owner takes over and the first is told it lost ownership
    Given the bot "ada" answers "Hello from Ada" to every message
    And an owner opens the session for bot "ada" in channel "general"
    When a second owner opens the session for bot "ada" in channel "general"
    Then the second owner holds ownership number 2
    And the first owner is told it lost ownership when it commits
    And the second owner can commit

  Scenario: A yielded session is resumed by a new owner without losing entries
    Given the bot "ada" answers "First answer" then "Second answer"
    And an owner opens the session for bot "ada" in channel "general"
    And the owner sends "one"
    When the owner yields the session
    And a second owner opens the session for bot "ada" in channel "general"
    And the second owner sends "two"
    Then the second owner receives the answer "Second answer"
    And the session holds the answers "First answer" and "Second answer"
