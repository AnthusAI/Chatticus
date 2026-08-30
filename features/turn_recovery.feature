Feature: Interrupted turn recovery
  As a household member
  I want interrupted work to resume or fail honestly
  So that no turn waits forever while appearing active

  Background:
    Given an empty control plane with turn recovery enabled

  Scenario: A worker disappears during a turn
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And a turn has committed partial progress
    And its active worker stops without completing
    When the turn deadline is reached
    Then exactly one later attempt resumes after the last committed event
    And the watcher does not remain open indefinitely

  Scenario: A worker disappears and recovery is exhausted
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And a turn has committed partial progress
    And its active worker stops without completing
    And recovery has already been attempted once
    When the turn deadline is reached
    Then the turn reaches a visible failed state with a reason
    And the watcher does not remain open indefinitely

  Scenario: An external call has an unknown outcome
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And a turn is waiting on an ambiguous provider outcome
    When recovery cannot prove the outcome
    Then the turn requests reconciliation
    And the system does not silently repeat a consequential operation

  Scenario: Retrying logical enqueue is idempotent
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When the same logical enqueue is requested twice for one turn
    Then only one queue delivery is recorded

  Scenario: The renew API extends claim and queue visibility for a fenced owner
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And a worker owns an active turn
    When the fenced owner calls the renew API
    Then its turn claim is extended
    And its queue visibility is extended

  Scenario: The computerless worker renews during a long model call
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And an active turn is waiting for a worker
    When the computerless worker runs a slow model call
    Then its turn claim is extended
    And its queue visibility is extended
