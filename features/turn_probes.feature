Feature: Deadline probes watch every turn
  As a household member
  I want a turn whose worker is gone to be picked up, finished or failed
  So that no turn stays active for ever without anyone working on it

  A probe is a delayed message that checks its own turn, so a turn that
  finishes needs nothing cancelled. A probe that finds a live owner looks
  again later. A probe that finds no owner resumes the turn, finishes it from
  the answer the conversation already holds, or fails it. An owner that is
  close to the end of its function time hands the turn on instead.

  Background:
    Given an empty control plane with turn recovery enabled
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"

  Scenario: A probe that finds a live owner watches the turn again
    Given a worker owns an active turn
    When the owner renews its claim just before it would run out
    And the probe for that attempt comes due
    Then the turn still belongs to that owner and is not recovered

  Scenario: A former owner whose turn was recovered can no longer renew its claim
    Given a worker owns an active turn
    And its active worker stops without completing
    When the turn deadline is reached
    And the former owner tries to renew its claim
    Then its claim and queue visibility are not extended

  Scenario: A turn that waits too long for its computer fails
    Given a turn is blocked on the browser gate with its worker claim released
    When the turn has waited for 16 minutes
    Then the turn has failed with reason "computer unavailable"
    And the turn waits no longer and no recovery is queued

  Scenario: A turn whose model already answered is finished when recovery is exhausted
    Given the model answers "The answer the first owner produced."
    And a worker's process ends after the model answered but before it committed the answer
    And recovery has already been attempted once
    When the turn deadline is reached
    Then the turn is finished from the answer the conversation already holds
    And the channel has exactly one bot answer with body "The answer the first owner produced."

  Scenario: A turn is handed on when its owner runs out of function time
    Given the model answers "Finished by the next owner."
    And the model answers "Finished by the next owner."
    And the model holds its first request
    When user "ryan" of tenant "anthus" posts "please finish the report" addressed to bot "Assistant" on the channel
    And bot "Assistant" starts a turn
    And the model is waiting on its first request
    And the function has 20 seconds of time left
    Then the turn is handed on to a later owner
    When the model is released
    And the started turn finishes
    Then the first owner ended by handing the turn on
    When bot "Assistant" completes one turn
    Then the channel has exactly one bot answer with body "Finished by the next owner."

  @owner-log
  Scenario: A model request that is never answered fails the turn and says what it waited on
    Given the model holds its first request
    And the model may stay silent for 300 milliseconds before the turn is failed
    When user "ryan" of tenant "anthus" posts "please finish the report" addressed to bot "Assistant" on the channel
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    And bot "Assistant" starts a turn
    And the model is waiting on its first request
    And the started turn finishes
    Then the turn has failed with reason "The model provider did not answer in time, so the turn was stopped."
    And user "ryan" receives a failed server-sent event with reason "The model provider did not answer in time, so the turn was stopped."
    And the console logged "model_call_deadline_exceeded" with "model_request_outstanding" as "true"
    And the console logged "model_call_deadline_exceeded" with "made_progress" as "false"
    And the console logged "pi_events" with "events" containing "turn_start"
    And the console logged "pi_state" with "scheduling" as "running"
    And the console logged "pi_state" with "submissions" containing "placed"
    And no job for bot "Assistant" is left to retry

  @owner-log
  Scenario: A turn that is handed on names what it was waiting on
    Given the model answers "Finished by the next owner."
    And the model holds its first request
    When user "ryan" of tenant "anthus" posts "please finish the report" addressed to bot "Assistant" on the channel
    And bot "Assistant" starts a turn
    And the model is waiting on its first request
    And the function has 20 seconds of time left
    Then the turn is handed on to a later owner
    And the console logged "turn_yielded" with "model_request_outstanding" as "true"
    And the console logged "turn_yielded" with "unsettled_inputs" as "1"
    And the console logged "turn_yielded" with "made_progress" as "false"

  @owner-log
  Scenario: A turn that hands itself on again without producing anything is failed
    Given the model holds its first request
    And a turn may hand itself on 1 times without producing anything
    When user "ryan" of tenant "anthus" posts "please finish the report" addressed to bot "Assistant" on the channel
    And bot "Assistant" starts a turn
    And the model is waiting on its first request
    And the function has 20 seconds of time left
    Then the turn is handed on to a later owner
    When the model holds its next request
    And bot "Assistant" starts a turn
    And the model is waiting on its first request
    And the function has 20 seconds of time left
    And the started turn finishes
    Then the turn has failed with reason "The turn handed itself on without making progress, so it was stopped."
    And the console logged "turn_yield_refused" with "maximum_fruitless_yields" as "1"
    And no job for bot "Assistant" is left to retry

  Scenario: A rejected key fails the turn with its reason even while a steering message is queued
    Given the model holds its first request
    And the model provider answers every request with status 401 and error code "invalid_api_key"
    When user "ryan" of tenant "anthus" posts "start the report" addressed to bot "Assistant" on the channel
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    And bot "Assistant" starts a turn
    And the model is waiting on its first request
    And user "ryan" of tenant "anthus" posts "and include totals" addressed to bot "Assistant" on the channel
    And the steered message has been taken into the conversation
    And the model is released
    And the started turn finishes
    Then the turn has failed with reason "The model provider rejected the API key."
    And user "ryan" receives a failed server-sent event with reason "The model provider rejected the API key."
    And the channel has 2 messages
    And no job for bot "Assistant" is left to retry
