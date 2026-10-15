Feature: A turn rides out transient DynamoDB failures instead of failing its invocation
  As a household member sending several messages in quick succession
  I want a turn to finish in the same worker invocation when the control store briefly refuses a write
  So that a momentary conflict between concurrent writers does not stall my turn until the queue redelivers it

  DynamoDB reports a write that collides with another transaction on the same item as a transient,
  retryable error. The turn control store repeats such a write with a short, jittered backoff and a
  small attempt budget. A failed condition is a different thing: it is real contention that the
  store already resolves itself, and it is never repeated.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"

  Scenario: Conflicts while closing and completing a turn are retried within the same invocation
    Given the model answers "Done after a brief conflict."
    And the next 2 attempts to mark the turn closing meet a conflicting transaction
    And the next 2 attempts to append the completion meet a conflicting transaction
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    And bot "Assistant" runs its turn in one invocation
    Then the invocation finalized the turn
    And the channel has exactly one bot answer with body "Done after a brief conflict."
    And marking the turn closing was attempted 3 times
    And appending the completion was attempted 3 times

  Scenario: A conflict that outlasts the retry budget still fails the invocation
    Given the model answers "Never delivered."
    And every attempt to mark the turn closing meets a conflicting transaction
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    And bot "Assistant" runs its turn in one invocation
    Then the invocation failed with a transaction conflict
    And marking the turn closing was attempted 5 times

  Scenario: A failed condition is not retried
    Given the model answers "Never delivered."
    And every attempt to mark the turn closing fails its condition
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    And bot "Assistant" runs its turn in one invocation
    Then the invocation ended with the turn lost
    And marking the turn closing was attempted 1 times
