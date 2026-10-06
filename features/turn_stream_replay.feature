Feature: Turn stream replay, heartbeat and terminal synthesis
  As the Chatticus product web app
  I want a turn stream to resume from the last event I saw and to always tell me how the turn ended
  So that a dropped connection, a quiet turn or an old turn never leaves the screen guessing

  Scenario: A reconnect with Last-Event-ID receives only what follows it
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And a turn has emitted committed events through sequence 4
    When user "ryan" of tenant "anthus" reconnects to the turn over HTTP with Last-Event-ID 4
    And the worker completes the turn with the answer "All done."
    Then the stream delivered only the completed event with sequence 5
    And the turn stream ends

  Scenario: Each frame carries its event name, then its id, then its data
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And a turn has emitted committed events through sequence 4
    When user "ryan" of tenant "anthus" reconnects to the turn over HTTP with Last-Event-ID 3
    Then the first frame is the event "turn.token" with id 4 and data carrying the same sequence in that order

  Scenario: A Last-Event-ID that is not a sequence is refused
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And a turn has emitted committed events through sequence 4
    When user "ryan" of tenant "anthus" opens the turn stream over HTTP with Last-Event-ID "abc"
    Then the turn stream is refused with status 400

  Scenario: A finished turn whose events expired still reports its outcome
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And a turn has emitted committed events through sequence 4
    And the worker completes the turn with the answer "All done."
    And the stored events of the turn have expired
    When user "ryan" of tenant "anthus" reconnects to the turn over HTTP with Last-Event-ID 2
    Then the stream delivered one synthesized terminal event "turn.completed"
    And the turn stream ends

  Scenario: A failed turn whose events expired reports its reason
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And a turn has emitted committed events through sequence 4
    And the worker fails the turn with the reason "the model is unavailable"
    And the stored events of the turn have expired
    When user "ryan" of tenant "anthus" reconnects to the turn over HTTP with Last-Event-ID 0
    Then the stream delivered one synthesized terminal event "turn.failed" with the reason "the model is unavailable"
    And the turn stream ends

  Scenario: A quiet stream carries a heartbeat comment every 15 seconds
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And a turn has emitted committed events through sequence 4
    And the turn streams run on a controlled clock
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    When 15 seconds pass on the turn stream clock
    Then the watcher has received 1 heartbeat comment
    When 15 seconds pass on the turn stream clock
    Then the watcher has received 2 heartbeat comments
    And the watcher received no terminal event

  Scenario: A stream that stays silent for ten minutes ends with a reconciling event
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And a turn has emitted committed events through sequence 4
    And the turn streams run on a controlled clock
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    When 600 seconds pass on the turn stream clock
    Then the watcher received one reconciling event carrying sequence 4
    And the turn stream ends
    And the turn remains active

  Scenario: A turn parked on a gate is not reconciled while it is silent
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And user "ryan" of tenant "anthus" has an active turn on the channel
    And the turn streams run on a controlled clock
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    When the worker posts a progress chunk and then waits on the browser gate
    And 600 seconds pass on the turn stream clock
    Then the watcher has received 1 heartbeat comment
    And the watcher received no terminal event
    And the watcher is still connected

  Scenario: A stream ends at its lifetime cap and the client resumes by reconnecting
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And a turn has emitted committed events through sequence 4
    And the turn streams run on a controlled clock
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    When 840 seconds pass on the turn stream clock
    Then the turn stream ends
    And the watcher received no terminal event
    When user "ryan" of tenant "anthus" reconnects to the turn over HTTP with Last-Event-ID 4
    And the worker completes the turn with the answer "All done."
    Then the stream delivered only the completed event with sequence 5
