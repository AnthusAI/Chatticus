Feature: Cost records are the same whichever owner ran the call
  As the operator of an organization computer
  I want a turn's cost records to be identical whether a Lambda owner or the computer owner made the calls
  So that moving a turn between owners never changes, doubles or loses what it cost

  Both owners run the same executor, and the cost of a turn is derived from the
  session, not from the process that ran the model. A turn that starts on Lambda,
  parks and finishes on the computer owner holds each call exactly once, and the
  calls the computer owner made through the model gateway match what the gateway
  saw.

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And the computer owner has an empty workspace directory

  Scenario: A turn that parks on Lambda and finishes on the computer holds each call once
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "draft-one"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    Then the session of the turn holds 1 cost record
    When computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the session of the turn holds 2 cost records
    And cost record 1 of the turn is round 1 on model "scripted-model" with 10 uncached input, 0 cache read, 0 cache write and 5 output tokens
    And cost record 2 of the turn is round 2 on model "scripted-model" with 10 uncached input, 0 cache read, 0 cache write and 5 output tokens
    And the vendor ledger row for the turn has input tokens 20
    And the vendor ledger row for the turn has output tokens 10
    And the turn index item of the turn names its bot, channel, prompt and owner kind "computer"

  Scenario: The Lambda owner and the computer owner through the gateway leave identical records for identical calls
    Given vendor price for model "gpt-5-nano" is 0.05 input and 0.40 output per million tokens
    And the model "scripted-model" then answers "Hello." as served by "gpt-5-nano" using 1000 uncached input, 0 cache read, 0 cache write and 200 output tokens
    And the vendor answers "Hello." using 1000 input tokens and 200 output tokens
    When the member asks "say hello"
    And a Lambda-style owner works the turn to its end
    And the cost records of the turn are remembered as "lambda"
    And the member asks "say hello again"
    And computer owner "alpha" takes over the turn through the model gateway
    Then the takeover of "alpha" ended "done"
    And the cost records of the turn are remembered as "computer"
    And the cost records remembered as "lambda" equal those remembered as "computer" apart from identifiers and time

  Scenario: The session records of a gateway turn agree with what the gateway observed
    Given vendor price for model "gpt-5-nano" is 0.05 input and 0.40 output per million tokens
    And the vendor answers "Hello from the computer." using 1000 input tokens and 200 output tokens
    When the member asks "say hello"
    And computer owner "alpha" takes over the turn through the model gateway
    Then the takeover of "alpha" ended "done"
    And the session of the turn holds 1 cost record
    And the gateway observations of the turn equal the tokens of its session cost records
    And the vendor ledger row for the turn has cost_usd 0.00013
