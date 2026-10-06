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
