Feature: The computer record lives in its own partition
  As the operator of an organization computer
  I want the one computer record of an organization kept apart from the roster
  So that a container owner may update the computer record without being able to touch bots, workers or tokens

  The computer record used to sit in the organization's roster partition under
  the sort key "computer", and IAM cannot narrow a grant by sort key. It now has
  the partition "<tenant>#computer#record". Existing records are moved once by
  migrate-computer-record; the code reads only the new key.

  Scenario: The computer record is stored under its own partition and not in the roster
    Given an empty control plane
    And tenant "anthus" user "ryan" has computer "household-computer"
    Then the Messaging table holds the computer record of "anthus" under the partition "anthus#computer#record"
    And the Messaging table holds nothing under the sort key "computer" in the partition "anthus#roster"

  Scenario: A record at the old key is invisible to the code until it is moved
    Given an empty control plane
    And the Messaging table holds a computer record of "anthus" at the old roster key
    Then the organization "anthus" has no computer record

  Scenario: A dry run reports the move and writes nothing
    Given an empty control plane
    And the Messaging table holds a computer record of "anthus" at the old roster key
    When the computer record move runs as a dry run
    Then the move reports "would_move" for "anthus"
    And the Messaging table still holds the computer record of "anthus" at the old roster key
    And the Messaging table holds nothing under the sort key "meta" in the partition "anthus#computer#record"

  Scenario: The move copies the record to the new key and deletes the old item
    Given an empty control plane
    And the Messaging table holds a computer record of "anthus" at the old roster key
    When the computer record move runs for real
    Then the move reports "moved" for "anthus"
    And the Messaging table holds the computer record of "anthus" under the partition "anthus#computer#record"
    And the Messaging table holds nothing under the sort key "computer" in the partition "anthus#roster"
    And the organization "anthus" has the computer record it had before the move

  Scenario: Running the move twice changes nothing the second time
    Given an empty control plane
    And the Messaging table holds a computer record of "anthus" at the old roster key
    When the computer record move runs for real
    And the computer record move runs for real
    Then the move reports nothing to move
    And the organization "anthus" has the computer record it had before the move

  Scenario: A record the new code already wrote is never overwritten by the stale old copy
    Given an empty control plane
    And the Messaging table holds a computer record of "anthus" at the old roster key
    And the new code has already written a newer computer record of "anthus"
    When the computer record move runs for real
    Then the move reports "already_moved" for "anthus"
    And the organization "anthus" has the newer computer record
    And the Messaging table holds nothing under the sort key "computer" in the partition "anthus#roster"

  Scenario: The move touches only the computer record of the roster
    Given an empty control plane
    And the Messaging table holds a computer record of "anthus" at the old roster key
    And tenant "anthus" user "ryan" has a bot named "helper"
    When the computer record move runs for real
    Then the roster of "anthus" still holds a bot
