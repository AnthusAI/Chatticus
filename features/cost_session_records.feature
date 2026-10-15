Feature: Every model call is a cost record in the session
  As the operator of an organization computer
  I want the cost of each model call kept as a record inside the durable Pi session
  So that cost survives retries, crashes, takeovers and a move of the session to another owner, exactly once

  The cost of a turn is not counted by a running total beside the session. Each
  model call is one keyed record in the session, derived from the assistant entry
  that answered it and priced from the versioned price book. The record is keyed
  by the entry, so writing it again is a no-op: a retry or a takeover never counts
  a call twice, and a crash after the answer was committed loses nothing because
  the next owner derives the same record from the entry. The vendor ledger row
  that the operator rollup and budget alerts sum, and the turn index item that
  carries the turn's dimensions, are both written from those records, never from
  a second count.

  Background:
    Given an empty control plane backed by a durable messaging store
    And tenant "anthus" user "ryan" has a bot named "Helper"
    And the default vendor prices of the production compositions are in force

  Scenario: Each model call of a turn is a cost record in the session
    Given the model "gpt-6-luna" calls the note tool with "checking" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" answers "Done" using 2000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello records"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    Then the session of the turn holds 2 cost records read through a fresh handle
    And cost record 1 of the turn is round 1 on model "gpt-6-luna" with 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And cost record 1 of the turn costs 0.00015 dollars under price book "openai@2026-10-13+pi-ai-1.0.2"
    And cost record 2 of the turn is round 2 on model "gpt-6-luna" with 2000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    And cost record 2 of the turn costs 0.00034 dollars under price book "openai@2026-10-13+pi-ai-1.0.2"
    And cost record 2 of the turn belongs to the turn

  Scenario: The ledger row and the turn index are written from the session records
    Given the model "gpt-6-luna" calls the note tool with "checking" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" answers "Done" using 2000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello projection"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    Then the cost summed from the session records of the turn equals the cost on its ledger row
    And the vendor ledger row for the turn has cost_usd 0.00049
    And the vendor ledger row for the turn has input tokens 7000
    And the vendor ledger row for the turn has output tokens 300
    And the turn index item of the turn names its bot, channel, prompt and owner kind "lambda"

  Scenario: A new owner of the session reads the same records
    Given the model "gpt-6-luna" answers "Moved hello" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello moved session"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And the cost records of the turn are remembered as "fresh handle"
    And a new owner of the session of the turn reads the cost records
    Then the cost records remembered as "fresh handle" equal those remembered as "new owner" exactly

  Scenario: A crash after the answer was committed and before its cost was recorded loses nothing
    Given vendor price for model "chatticus-test-model" is 2.00 input and 4.00 output per million tokens
    And the model "chatticus-test-model" answers "Recovered answer"
    When bot "Helper" is asked "hello lost cost"
    And the worker of bot "Helper" with model "chatticus-test-model" crashes after the model answered and before recording its cost
    Then the session of the turn holds 0 cost records
    When time passes until the turn is recovered
    Then the turn has completed
    And the session of the turn holds 1 cost record
    And the model "chatticus-test-model" was called 1 time
    And the vendor ledger row for the turn has input tokens 10
    And the vendor ledger row for the turn has output tokens 5
    And the vendor ledger row for the turn has cost_usd 0.00004

  Scenario: A retry after the cost was recorded does not count the call again
    Given vendor price for model "chatticus-test-model" is 2.00 input and 4.00 output per million tokens
    And the model "chatticus-test-model" answers "Recovered answer"
    When bot "Helper" is asked "hello retried cost"
    And the worker of bot "Helper" with model "chatticus-test-model" crashes right after recording the spend of its answer
    Then the session of the turn holds 1 cost record
    When time passes until the turn is recovered
    Then the turn has completed
    And the session of the turn holds 1 cost record
    And the model "chatticus-test-model" was called 1 time
    And the vendor ledger row for the turn has input tokens 10
    And the vendor ledger row for the turn has cost_usd 0.00004

  Scenario: A turn that fails after a call keeps that call's cost record and records the failed response too
    Given vendor price for model "chatticus-test-model" is 2.00 input and 4.00 output per million tokens
    And the model "chatticus-test-model" calls the note tool with "checking" and then the provider rejects the request with status 401 and error code "invalid_api_key"
    When bot "Helper" is asked "hello failing records"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "chatticus-test-model" that fails
    Then the session of the turn holds 2 cost records
    And cost record 2 of the turn is round 2 on model "chatticus-test-model" with 0 uncached input, 0 cache read, 0 cache write and 0 output tokens
    And the vendor ledger row for the turn has cost_usd 0.00004

  Scenario: A fork gets no cost record of its parent
    Given the model "gpt-6-luna" answers "Forked hello" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello fork"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And the conversation of the session of the turn is forked at its last entry
    Then deriving cost records on the fork writes 0 records
    And the fork holds 0 cost records
    And the session of the turn holds 1 cost record
