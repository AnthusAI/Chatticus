Feature: Every model call a conversation makes is metered, however it ended
  As the operator of an organization computer
  I want compaction summaries and the calls that errored or were cut off to be cost records too
  So that the cost of a turn is everything the vendor billed for it, not only its successful answers

  A turn's cost is the sum of its cost records. A model call that produced an
  answer is a record derived from its assistant entry. Two kinds of spend have
  no successful answer to derive from: a compaction summary, which the session
  keeps only in its own usage ledger (pi.usage), and a response that errored or
  was cut off, which the session does keep as an entry, with whatever usage the
  provider had counted. Compaction is recovered as the usage ledger's total
  minus what the entries account for, minus what earlier compaction records
  already hold, so repeating the derivation never records it twice. A response
  that errored or was aborted before the provider counted anything is a record
  with no tokens; the gateway observation (see
  cost_gateway_observations.feature) is what covers the vendor having billed it.

  Background:
    Given an empty control plane backed by a durable messaging store
    And tenant "anthus" user "ryan" has a bot named "Helper"
    And the default vendor prices of the production compositions are in force

  Scenario: A compaction summary is a cost record of its own
    Given the model "gpt-6-luna" calls the note tool with "checking" using 125000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" summarizes the conversation for compaction using 900 uncached input, 0 cache read, 0 cache write and 60 output tokens
    And the model "gpt-6-luna" answers "Done" using 2000 uncached input, 0 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello compaction"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    Then the session of the turn holds 3 cost records
    And the compaction cost records of the turn total 900 uncached input and 60 output tokens
    And the compaction cost records of the turn cost 0.00012 dollars
    And the vendor ledger row for the turn has output tokens 360
    And the cost summed from the session records of the turn equals the cost on its ledger row

  Scenario: Deriving the cost again does not record the compaction again
    Given the model "gpt-6-luna" calls the note tool with "checking" using 125000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" summarizes the conversation for compaction using 900 uncached input, 0 cache read, 0 cache write and 60 output tokens
    And the model "gpt-6-luna" answers "Done" using 2000 uncached input, 0 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello repeated compaction"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And the cost records of the turn are derived again from the session
    Then the session of the turn holds 3 cost records
    And the compaction cost records of the turn total 900 uncached input and 60 output tokens

  Scenario: A later compaction records only the spend that is new
    Given the model "gpt-6-luna" calls the note tool with "checking" using 125000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" summarizes the conversation for compaction using 900 uncached input, 0 cache read, 0 cache write and 60 output tokens
    And the model "gpt-6-luna" answers "Done" using 2000 uncached input, 0 cache read, 0 cache write and 200 output tokens
    And the model "gpt-6-luna" calls the note tool with "checking again" using 125000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" summarizes the conversation for compaction using 700 uncached input, 0 cache read, 0 cache write and 50 output tokens
    And the model "gpt-6-luna" answers "Done again" using 2000 uncached input, 0 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello first compaction"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And bot "Helper" is asked "hello second compaction"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    Then the compaction cost records of the turn total 700 uncached input and 50 output tokens
    And the session of the turn holds 3 cost records

  Scenario: An errored response is a cost record with the tokens the provider had counted
    Given the model "gpt-6-luna" calls the note tool with "checking" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" is then rejected with status 401 and error code "invalid_api_key" after counting 1500 uncached input and 40 output tokens
    When bot "Helper" is asked "hello errored response"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna" that fails
    Then the session of the turn holds 2 cost records
    And cost record 2 of the turn is round 2 on model "gpt-6-luna" with 1500 uncached input, 0 cache read, 0 cache write and 40 output tokens
    And the vendor ledger row for the turn has output tokens 140

  Scenario: An aborted response keeps the partial usage the provider had counted
    Given the model "gpt-6-luna" is cut off after "Half an ans" having counted 800 uncached input and 12 output tokens
    When bot "Helper" is asked "hello aborted response"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna" that fails
    Then the session of the turn holds 1 cost record
    And cost record 1 of the turn is round 1 on model "gpt-6-luna" with 800 uncached input, 0 cache read, 0 cache write and 12 output tokens
    And the vendor ledger row for the turn has input tokens 800
