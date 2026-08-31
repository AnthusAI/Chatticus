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
    When user "ryan" of tenant "anthus" reconnects to the turn after sequence 2
    Then committed events 3 and 4 are replayed once in order
    And later events continue from the same turn
    And the turn completes whether or not a watcher remains connected

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
