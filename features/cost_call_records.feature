Feature: Every model call is counted exactly once on the vendor ledger
  As the operator of an organization computer
  I want the vendor ledger row of a turn to hold the tokens and dollars of each model call exactly once
  So that the cost I see for a turn is the cost the vendor billed, whichever process ran the turn

  The ledger row of a turn has one writer for each call. A turn run by a Lambda
  owner is metered from the Pi session when the turn finishes. A turn run by
  the computer owner reaches the model through the model gateway, and the same
  session is measured when the turn finishes there too; neither path may add
  the same call a second time.

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And the computer owner has an empty workspace directory

  Scenario: A Lambda owner records the model call once
    Given vendor price for model "scripted-model" is 2.00 input and 4.00 output per million tokens
    And the model is scripted to answer "Hello from Lambda." using 1000 input tokens and 200 output tokens
    When the member asks "say hello"
    And a Lambda-style owner works the turn to its end
    Then the vendor ledger row for the turn has input tokens 1000
    And the vendor ledger row for the turn has output tokens 200
    And the vendor ledger row for the turn has cost_usd 0.0028

  Scenario: A computer owner that reaches the model through the gateway records the model call once
    Given vendor price for model "gpt-5-nano" is 0.05 input and 0.40 output per million tokens
    And the vendor answers "Hello from the computer." using 1000 input tokens and 200 output tokens
    When the member asks "say hello"
    And computer owner "alpha" takes over the turn through the model gateway
    Then the takeover of "alpha" ended "done"
    And the vendor received exactly 1 request
    And the vendor ledger row for the turn has input tokens 1000
    And the vendor ledger row for the turn has output tokens 200
    And the vendor ledger row for the turn has cost_usd 0.00013
