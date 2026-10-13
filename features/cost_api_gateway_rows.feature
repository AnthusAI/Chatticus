Feature: The cost API labels what it cannot be sure of: unpriced, estimated and gateway-sourced calls

  As a member of an organization
  I want the cost figures to say when they are incomplete or estimated
  So that a total is never mistaken for more than it is

  Most of a turn's cost is derived from the session's call records and is exact. Two
  kinds of spend are not: a call to a model the price book has no price for, whose
  dollars are unknown, and a call only the model gateway saw, which the reconciliation
  adds as a row of its own (see cost_gateway_reconciliation.feature), flagged as an
  estimate when the stream was interrupted. The cost API (see cost_api.feature) keeps
  all three visible. An unpriced call is counted in `unpriced_calls` and leaves the
  dollar total unknown (null), never zero. A gateway row says where it came from, and
  a call the session recorded is never counted a second time through its gateway row.

  Background:
    Given an empty control plane backed by a durable messaging store
    And tenant "anthus" user "ryan" has a bot named "Helper"
    And user "pat" is an ordinary member of tenant "anthus"

  Scenario: A call with no price is reported as unpriced and never counted as zero
    Given the model answers "Priced" as response "resp_priced" using 1000 uncached input and 100 output tokens
    When bot "Helper" is asked "hello unpriced"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "scripted-model"
    And the gateway observed response "resp_unpriced" of model "gpt-9-unpriced" for the turn with 700 input and 70 output tokens
    And 10800 seconds pass
    And the gateway observations of the organization are reconciled
    And member "pat" gets "/costs"
    Then the response field "totals.unpriced_calls" is "1"
    And the response field "totals.complete" is "false"
    And the response field "totals.cost_usd" is null
    And the response field "totals.priced_cost_usd" is "0.0011"
    And the response field "totals.by_model[model=gpt-9-unpriced].unpriced_calls" is "1"
    And the response field "totals.by_model[model=gpt-9-unpriced].priced_cost_usd" is "0"
    When member "pat" gets "/costs?group_by=bot"
    Then the response field "groups[key={bot:Helper}].totals.cost_usd" is "0.0011"
    And the response field "groups[key={bot:Helper}].totals.complete" is "true"
    And the response field "groups[key=null].totals.unpriced_calls" is "1"
    And the response field "groups[key=null].totals.cost_usd" is null
    And the groups of the response add up to its totals
    When member "pat" gets "/costs/turns"
    Then the unpriced row of the response has no dollar total and says it is a gateway call

  Scenario: Gateway-sourced and estimated rows are labelled
    Given the model answers "Session" as response "resp_session" using 1000 uncached input and 100 output tokens
    When bot "Helper" is asked "hello labels"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "scripted-model"
    And the gateway observed an estimate of response "resp_cut_off" for the turn with 700 input and 70 output tokens
    And 10800 seconds pass
    And the gateway observations of the organization are reconciled
    And member "pat" gets "/costs/turns"
    Then the response field "totals.rows" is "2"
    And the response field "totals.gateway_rows" is "1"
    And the response field "totals.estimated_rows" is "1"
    And the response field "totals.turns" is "1"
    And the estimated gateway row of the response costs 0.00077 dollars and the session row has source "session"

  Scenario: A gateway observation of a call the session recorded is not counted twice
    Given the model answers "Matched" as response "resp_matched" using 1000 uncached input and 100 output tokens
    When bot "Helper" is asked "hello matched"
    And the gateway observed response "resp_matched" for the turn with 1000 input and 100 output tokens
    And 10800 seconds pass
    And the gateway observations of the organization are reconciled
    And member "pat" gets "/costs"
    Then the response field "totals.gateway_rows" is "1"
    When bot "Helper" runs one vendor-ledger computerless worker turn with model "scripted-model"
    And member "pat" gets "/costs"
    Then the response field "totals.rows" is "1"
    And the response field "totals.gateway_rows" is "0"
    And the response field "totals.cost_usd" is "0.0011"
