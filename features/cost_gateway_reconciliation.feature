Feature: A model call is counted exactly once, whichever of the session and the gateway saw it
  As the operator of an organization computer
  I want the gateway's observations reconciled against the session's cost records
  So that no call is counted twice and no call the vendor billed is lost

  A call has one identity, the vendor's response id. The session's cost record
  of a call carries it, and so does the gateway's observation of it. When both
  exist they are the same call and the session's record is the cost. When only
  the gateway saw a call it is counted from the observation, flagged as sourced
  from the gateway, once it is old enough that the session is not about to
  account for it. A summarization call has no response id in the session, so
  the turn's compaction records absorb the observations that fit them. The
  verdict is recomputed from the current records on every run, so reconciling
  again changes nothing, and a call counted from its observation is withdrawn
  the moment the session's record appears.

  Background:
    Given an empty control plane backed by a durable messaging store
    And tenant "anthus" user "ryan" has a bot named "Helper"

  Scenario: An observation of a call the session recorded is not counted again
    Given the model answers "Matched" as response "resp_matched" using 1000 uncached input and 100 output tokens
    When bot "Helper" is asked "hello matched"
    And the gateway observed response "resp_matched" for the turn with 1000 input and 100 output tokens
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "scripted-model"
    And 10800 seconds pass
    And the gateway observations of the organization are reconciled
    Then the organization holds 0 gateway-sourced cost rows
    And the observation of response "resp_matched" is reconciled as "matched"
    And the vendor ledger row for the turn has input tokens 1000

  Scenario: A call the session never committed is counted once from its observation
    Given the model answers "Only this one" as response "resp_session" using 10 uncached input and 5 output tokens
    When bot "Helper" is asked "hello lost call"
    And the gateway observed response "resp_lost" for the turn with 700 input and 70 output tokens
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "scripted-model"
    And 10800 seconds pass
    And the gateway observations of the organization are reconciled
    Then the organization holds 1 gateway-sourced cost row with 700 input and 70 output tokens costing 0.00077 dollars
    And each gateway-sourced cost row also has a cost index item flagged as a gateway call
    And the observation of response "resp_lost" is reconciled as "orphan"
    And the reconciliation flags the turn
    When the gateway observations of the organization are reconciled again
    Then the organization holds 1 gateway-sourced cost row with 700 input and 70 output tokens costing 0.00077 dollars
    And the vendor ledger row for the turn has input tokens 10

  Scenario: A call the session may still be about to record is not counted yet
    Given the model answers "Soon" as response "resp_soon" using 10 uncached input and 5 output tokens
    When bot "Helper" is asked "hello recent call"
    And the gateway observed response "resp_unrecorded" for the turn with 700 input and 70 output tokens
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "scripted-model"
    And the gateway observations of the organization are reconciled
    Then the organization holds 0 gateway-sourced cost rows
    And the reconciliation found 1 pending observation

  Scenario: A small unaccounted call is counted but does not flag the turn
    Given the model answers "Big enough" as response "resp_big" using 10000 uncached input and 1000 output tokens
    When bot "Helper" is asked "hello small gap"
    And the gateway observed response "resp_big" for the turn with 10000 input and 1000 output tokens
    And the gateway observed response "resp_small" for the turn with 100 input and 10 output tokens
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "scripted-model"
    And 10800 seconds pass
    And the gateway observations of the organization are reconciled
    Then the organization holds 1 gateway-sourced cost row with 100 input and 10 output tokens costing 0.00011 dollars
    And the reconciliation does not flag the turn

  Scenario: A call counted from its observation is withdrawn when the session's record appears later
    Given the model holds its first request
    And the model answers "Late answer" as response "resp_late" using 1000 uncached input and 100 output tokens
    When bot "Helper" is asked "hello late entry"
    And bot "Helper" starts a turn
    And the model is waiting on its first request
    And the gateway observed response "resp_late" for the turn with 1000 input and 100 output tokens
    And 10800 seconds pass
    And the gateway observations of the organization are reconciled
    Then the organization holds 1 gateway-sourced cost row with 1000 input and 100 output tokens costing 0.0011 dollars
    When the model is released
    And the started turn finishes
    And the gateway observations of the organization are reconciled
    Then the organization holds 0 gateway-sourced cost rows
    And the observation of response "resp_late" is reconciled as "matched"
    And the vendor ledger row for the turn has input tokens 1000

  Scenario: A summarization call is accounted for by the turn's compaction records
    Given the default vendor prices of the production compositions are in force
    And the model "gpt-6-luna" calls the note tool with "checking" using 125000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" summarizes the conversation for compaction using 900 uncached input, 0 cache read, 0 cache write and 60 output tokens
    And the model "gpt-6-luna" answers "Done" using 2000 uncached input, 0 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello summarized"
    And the gateway observed response "resp_summary" of model "gpt-6-luna" for the turn with 900 input and 60 output tokens
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And 10800 seconds pass
    And the gateway observations of the organization are reconciled
    Then the organization holds 0 gateway-sourced cost rows
    And the observation of response "resp_summary" is reconciled as "compaction"

  Scenario: Observing the same call twice keeps one observation, and an estimate never replaces the vendor's figure
    When bot "Helper" is asked "hello twice observed"
    And the gateway observed response "resp_twice" for the turn with 500 input and 50 output tokens
    And the gateway observed an estimate of response "resp_twice" for the turn with 40 input and 4 output tokens
    Then the gateway kept 1 observation for the turn
    And the observation of response "resp_twice" has 500 input and 50 output tokens and is final

  Scenario: The vendor's figure replaces an earlier estimate of the same call
    When bot "Helper" is asked "hello refined"
    And the gateway observed an estimate of response "resp_refined" for the turn with 40 input and 4 output tokens
    And the gateway observed response "resp_refined" for the turn with 500 input and 50 output tokens
    Then the gateway kept 1 observation for the turn
    And the observation of response "resp_refined" has 500 input and 50 output tokens and is final
