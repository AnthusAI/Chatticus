Feature: Turn-scoped server-sent events
  As the chattic.us web app
  I want turn-scoped durable server-sent events
  So that progress reaches the browser without in-process subscriptions
  And without holding a connection that outlives the turn

  Scenario: Watch an active turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And bot "Researcher" is producing an answer for a turn on the channel
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    When the worker posts several coalesced progress chunks for the turn
    Then user "ryan" receives the chunks in order before completion
    And user "ryan" receives one terminal server-sent event
    And the turn stream ends
    And no connection remains open for the channel or chat tab

  Scenario: Resume after a dropped stream
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And a turn has emitted committed events through sequence 4
    And the watching connection for that turn closes
    When user "ryan" of tenant "anthus" reconnects to the turn with Last-Event-ID 2
    Then committed events 3 and 4 are replayed once in order
    And later events continue from the same turn
    And the turn completes whether or not a watcher remains connected

  Scenario: Turn journal reconnects after a seq without opening SSE
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And a turn has emitted committed events through sequence 4
    When user "ryan" of tenant "anthus" lists turn events after seq 2
    Then the turn listing contains only events 3 and 4 in order

  Scenario: Another tenant cannot watch a turn stream
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And user "ryan" of tenant "anthus" has an active turn on the channel
    When tenant "other" tries to open the turn stream
    Then turn stream access is denied because the tenant does not match

  Scenario: A fenced worker can wait on a capability without completing the turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And user "ryan" of tenant "anthus" has an active turn on the channel
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    When the worker posts a progress chunk and then waits on the browser gate
    Then user "ryan" receives a waiting server-sent event naming browser
    And the turn remains active
    And the turn is still waiting on the browser gate

  Scenario: Resume is refused while the household computer is stopped
    Given an empty control plane
    And tenant "anthus" user "ryan" household computer is stopped
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And user "ryan" of tenant "anthus" has an active turn on the channel
    When the worker posts a progress chunk and then waits on the browser gate
    And user "ryan" of tenant "anthus" tries to resume that waiting turn
    Then resume is refused because the computer is not ready
    And the turn remains active
    And the turn is still waiting on the browser gate

  Scenario: A waiting turn exposes its gate over HTTP
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And user "ryan" of tenant "anthus" has an active turn on the channel
    When the worker posts a progress chunk and then waits on the browser gate
    Then user "ryan" can read the turn gate as browser without opening SSE
    And user "ryan" can read the pending computer tool request_computer_capability for browser

  Scenario: A waiting journal event carries the pending computer tool
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And user "ryan" of tenant "anthus" has an active turn on the channel
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    When the worker posts a progress chunk and then waits on the browser gate
    Then user "ryan" receives a waiting server-sent event naming browser
    And the waiting journal event names request_computer_capability for browser
    And user "ryan" reads the same action identifier from GET and the journal
