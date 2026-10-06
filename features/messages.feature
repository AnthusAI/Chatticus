Feature: Channels and the message store
  As a Chatticus user
  I want conversations stored as append-only messages in channels
  So that bots can talk to me and to each other on one channel
  And files stay on the shared computer instead of in the transcript

  Scenario: A computerless worker waits when the model needs the browser
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And tenant "anthus" user "ryan" household computer is stopped
    When user "ryan" of tenant "anthus" posts "research this and open the household browser" addressed to bot "Assistant" on the channel
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    And bot "Assistant" runs one computerless worker turn
    Then user "ryan" receives a waiting server-sent event naming browser
    And the turn remains active
    And the turn is still waiting on the browser gate
    And tenant "anthus" user "ryan" household computer remains stopped

  Scenario: A computerless worker does not retry the model on a waiting turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And tenant "anthus" user "ryan" household computer is stopped
    When user "ryan" of tenant "anthus" posts "research this and open the household browser" addressed to bot "Assistant" on the channel
    And a counting computerless worker processes bot "Assistant"
    And the same waiting turn is delivered to a computerless worker again
    Then only one worker begins the model attempt
    And the turn remains active
    And the pending computer tool action identifier is unchanged
    And tenant "anthus" user "ryan" household computer remains stopped

  Scenario: A computerless worker does not take a computer continuation job
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And tenant "anthus" user "ryan" household computer is stopped
    When user "ryan" of tenant "anthus" posts "research this and open the household browser" addressed to bot "Assistant" on the channel
    And a counting computerless worker processes bot "Assistant"
    And tenant "anthus" user "ryan" household computer is running
    And user "ryan" of tenant "anthus" resumes that waiting turn
    And a computerless worker is given the continuation job
    Then the computerless worker refuses the computer job
    And the continuation job remains queued
    And only one worker begins the model attempt
    And the turn remains active

  Scenario: Resume does not publish a computer job to the cpu queue
    Given an empty control plane with a cpu enqueue hook
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And tenant "anthus" user "ryan" household computer is stopped
    When user "ryan" of tenant "anthus" posts "research this and open the household browser" addressed to bot "Assistant" on the channel
    And a counting computerless worker processes bot "Assistant"
    And tenant "anthus" user "ryan" household computer is running
    And user "ryan" of tenant "anthus" resumes that waiting turn
    Then the continuation job requires computer
    And the cpu enqueue hook was not invoked for that job
    And the turn remains active

  Scenario: Resume publishes a computer job to the computer queue
    Given an empty control plane with cpu and computer enqueue hooks
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And tenant "anthus" user "ryan" household computer is stopped
    When user "ryan" of tenant "anthus" posts "research this and open the household browser" addressed to bot "Assistant" on the channel
    And a counting computerless worker processes bot "Assistant"
    And tenant "anthus" user "ryan" household computer is running
    And user "ryan" of tenant "anthus" resumes that waiting turn
    Then the continuation job requires computer
    And the cpu enqueue hook was not invoked for that job
    And the computer enqueue hook received that job
    And the turn remains active

  Scenario: Resume names the computer capability on the HTTP response
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And tenant "anthus" user "ryan" household computer is stopped
    When user "ryan" of tenant "anthus" posts "research this and open the household browser" addressed to bot "Assistant" on the channel
    And a counting computerless worker processes bot "Assistant"
    And tenant "anthus" user "ryan" household computer is running
    And user "ryan" of tenant "anthus" resumes that waiting turn
    Then the resume response requires computer
    And the turn remains active

  Scenario: A user's active turns can be listed after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Researcher |
    And user "ryan" of tenant "anthus" posts a fence probe addressed to bot "Researcher" without enqueueing a turn job
    And tenant "anthus" user "ryan" opens a channel with bots:
      | Writer |
    And user "ryan" of tenant "anthus" posts a fence probe addressed to bot "Writer" without enqueueing a turn job
    And a recycled Front Door serves the same messaging store
    Then tenant "anthus" can list active turns for user "ryan":
      | 1 |
      | 2 |
