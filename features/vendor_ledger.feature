Feature: Vendor spend ledger
  As a Chatticus operator
  I want each model call recorded on the vendor spend ledger
  So that tokens and vendor-billed dollars are attributed per turn and tenant

  Background:
    Given an empty control plane backed by a durable messaging store
    And tenant "anthus" user "ryan" has a bot named "Helper"

  Scenario: A vendor turn with a known test price records tokens and dollars
    Given vendor price for model "chatticus-test-model" is 2.00 input and 4.00 output per million tokens
    When bot "Helper" is asked "hello ledger"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "chatticus-test-model"
    Then the vendor ledger row for the turn has billed_via "vendor"
    And the vendor ledger row for the turn has input tokens 10
    And the vendor ledger row for the turn has output tokens 5
    And the vendor ledger row for the turn has frozen input price 2.00 per million
    And the vendor ledger row for the turn has frozen output price 4.00 per million
    And the vendor ledger row for the turn has cost_usd 0.00004

  Scenario: An unknown model records tokens with null dollars
    When bot "Helper" is asked "hello unknown model"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "unknown-model-id"
    Then the vendor ledger row for the turn has input tokens 10
    And the vendor ledger row for the turn has output tokens 5
    And the vendor ledger row for the turn has null cost_usd
    And the vendor ledger row for the turn has null frozen prices

  Scenario: AWS-billed inference keeps cost_usd null even when a price exists
    Given vendor price for model "chatticus-test-model" is 2.00 input and 4.00 output per million tokens
    When bot "Helper" is asked "hello aws billed"
    And vendor spend is recorded for the turn with model "chatticus-test-model" and billed_via "aws"
    Then the vendor ledger row for the turn has billed_via "aws"
    And the vendor ledger row for the turn has null cost_usd

  Scenario: A second model call on the same turn sums tokens using frozen first-write rates
    Given vendor price for model "chatticus-test-model" is 2.00 input and 4.00 output per million tokens
    When vendor spend is recorded for turn "ledger-retry-turn" with model "chatticus-test-model" and tokens 10 in 5 out
    And vendor price for model "chatticus-test-model" is 99.00 input and 99.00 output per million tokens
    And vendor spend is recorded for turn "ledger-retry-turn" with model "chatticus-test-model" and tokens 3 in 2 out
    Then the vendor ledger row for turn "ledger-retry-turn" has input tokens 13
    And the vendor ledger row for turn "ledger-retry-turn" has output tokens 7
    And the vendor ledger row for turn "ledger-retry-turn" has frozen input price 2.00 per million
    And the vendor ledger row for turn "ledger-retry-turn" has frozen output price 4.00 per million
    And the vendor ledger row for turn "ledger-retry-turn" has cost_usd 0.000054

  Scenario: A recovered attempt does not record the same spend twice
    Given vendor price for model "chatticus-test-model" is 2.00 input and 4.00 output per million tokens
    And the model "chatticus-test-model" answers "Recovered answer"
    When bot "Helper" is asked "hello recovery"
    And the worker of bot "Helper" with model "chatticus-test-model" crashes right after recording the spend of its answer
    Then the vendor ledger row for the turn has input tokens 10
    And the vendor ledger row for the turn has output tokens 5
    When time passes until the turn is recovered
    Then the turn has completed
    And the model "chatticus-test-model" was called 1 time
    And the vendor ledger row for the turn has input tokens 10
    And the vendor ledger row for the turn has output tokens 5
    And the vendor ledger row for the turn has cost_usd 0.00004

  Scenario: A turn that fails after a model call still records that call's spend
    Given vendor price for model "chatticus-test-model" is 2.00 input and 4.00 output per million tokens
    And the model "chatticus-test-model" calls the note tool with "checking" and then the provider rejects the request with status 401 and error code "invalid_api_key"
    When bot "Helper" is asked "hello failing turn"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "chatticus-test-model" that fails
    Then the turn has failed with reason "The model provider rejected the API key."
    And the vendor ledger row for the turn has input tokens 10
    And the vendor ledger row for the turn has output tokens 5
    And the vendor ledger row for the turn has cost_usd 0.00004
