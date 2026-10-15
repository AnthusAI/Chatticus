Feature: A turn handed on keeps the cost of the calls it already made
  As the operator of an organization computer
  I want the cost of every finished model call recorded before a turn is handed to another owner
  So that nothing a turn already spent depends on the owner that is about to disappear

  An owner that runs out of function time hands its turn on. The calls it
  already finished are in the session, and the cost records for them are written
  at that moment, before the next owner starts; the next owner does not write
  them again.

  Background:
    Given an empty control plane with turn recovery enabled
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"

  Scenario: The first call of a turn is recorded before the turn is handed on, and the next owner adds only its own
    Given the model "scripted-model" calls the note tool with "checking" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "scripted-model" answers "Finished by the next owner." using 10 uncached input, 0 cache read, 0 cache write and 5 output tokens
    And the model "scripted-model" answers "Finished by the next owner." using 10 uncached input, 0 cache read, 0 cache write and 5 output tokens
    And the model holds its second request
    When user "ryan" of tenant "anthus" posts "please finish the report" addressed to bot "Assistant" on the channel
    And bot "Assistant" starts a turn
    And the model is waiting on its second request
    And the function has 20 seconds of time left
    Then the turn is handed on to a later owner
    And the session of the turn holds 1 cost record
    And cost record 1 of the turn is round 1 on model "scripted-model" with 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When the model is released
    And the started turn finishes
    Then the first owner ended by handing the turn on
    When bot "Assistant" completes one turn
    Then the session of the turn holds 2 cost records
    And cost record 1 of the turn is round 1 on model "scripted-model" with 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the cost records of the turn have distinct keys per entry
