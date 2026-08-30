Feature: Durable turn attempts
  As a household member
  I want queue retries to be invisible
  So that one request never becomes two answers or two bills from concurrent model calls

  Scenario: Two workers receive the same logical turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And one unfinished turn job is delivered twice
    When two workers try to process it concurrently
    Then only one worker begins the model attempt
    And only that attempt can append progress or completion
    And the channel receives at most one final answer

  Scenario: An expired worker resumes late
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And a turn has been reassigned to a newer attempt
    When the expired attempt tries to append output or execute an action
    Then the operation is rejected
    And only the newer attempt can change the turn
    And the user sees no duplicate output or action
