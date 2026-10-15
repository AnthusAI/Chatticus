Feature: Pi orphan sweeper
  As the Chatticus operator
  I want commit objects that no commit ever made visible to be cleaned up
  So that a crashed commit leaves no litter, and committed history is never touched

  Background:
    Given a fresh Pi session store
    And the sweeper leaves objects alone for 10 minutes

  Scenario: A commit object left by a crashed commit is deleted once its owner has been replaced
    Given owner 1 of the session "ada" has committed 2 notes
    And owner 1 of the session "ada" crashes after writing the object of its next commit and before the index transaction
    And owner 2 takes over the session "ada"
    When 11 minutes pass
    And the sweeper sweeps the session "ada"
    Then the sweeper deleted 1 object
    And the commit object of sequence 3 written by owner 1 of the session "ada" no longer exists
    And a cold reader reads the notes "note 1" and "note 2" in the session "ada"

  Scenario: The crashed owner's object is also deleted after the next owner has committed past it
    Given owner 1 of the session "ada" has committed 2 notes
    And owner 1 of the session "ada" crashes after writing the object of its next commit and before the index transaction
    And owner 2 of the session "ada" has committed 2 notes
    When 11 minutes pass
    And the sweeper sweeps the session "ada"
    Then the sweeper deleted 1 object
    And the commit object of sequence 3 written by owner 1 of the session "ada" no longer exists
    And a cold reader reads 4 notes in the session "ada"

  Scenario: An unreferenced object at or below the committed sequence is deleted even while its fence is current
    Given owner 1 of the session "ada" has committed 1 note
    And owner 2 of the session "ada" has committed 1 note
    And a stray commit object is written at sequence 1 under fence 2 in the session "ada"
    When 11 minutes pass
    And the sweeper sweeps the session "ada"
    Then the sweeper deleted 1 object
    And the commit object of sequence 1 written by owner 2 of the session "ada" no longer exists
    And a cold reader reads 2 notes in the session "ada"

  Scenario: A committed object is never deleted, even after its owner has been replaced and a year has passed
    Given owner 1 of the session "ada" has committed 3 notes
    And owner 2 of the session "ada" has committed 1 note
    When 365 days pass
    And the sweeper sweeps the session "ada"
    Then the sweeper deleted 0 objects
    And the session "ada" still has 4 commit objects
    And a cold reader reads 4 notes in the session "ada"

  Scenario: An orphan inside the grace window is kept and is deleted once the window has passed
    Given owner 1 of the session "ada" has committed 2 notes
    And owner 1 of the session "ada" crashes after writing the object of its next commit and before the index transaction
    And owner 2 takes over the session "ada"
    When the sweeper sweeps the session "ada"
    Then the sweeper deleted 0 objects
    And the commit object of sequence 3 written by owner 1 of the session "ada" still exists
    When 11 minutes pass
    And the sweeper sweeps the session "ada"
    Then the sweeper deleted 1 object
    And the commit object of sequence 3 written by owner 1 of the session "ada" no longer exists

  Scenario: An object newer than the committed sequence under the current fence is kept however old it is
    Given owner 1 of the session "ada" has committed 2 notes
    And a stray commit object is written at sequence 3 under fence 1 in the session "ada"
    When 30 days pass
    And the sweeper sweeps the session "ada"
    Then the sweeper deleted 0 objects
    And the commit object of sequence 3 written by owner 1 of the session "ada" still exists

  Scenario: A commit that is still in flight survives a sweep and then completes
    Given owner 1 of the session "ada" has committed 2 notes
    And owner 1 of the session "ada" has started its next commit with the index transaction held back
    When 2 days pass
    And the sweeper sweeps the session "ada"
    Then the sweeper deleted 0 objects
    And the commit object of sequence 3 written by owner 1 of the session "ada" still exists
    When the held index transaction is released
    Then the held commit completes
    And a cold reader reads 3 notes in the session "ada"

  Scenario: Sweeping the whole bucket reaches every session
    Given owner 1 of the session "ada" has committed 1 note
    And owner 1 of the session "ada" crashes after writing the object of its next commit and before the index transaction
    And owner 2 takes over the session "ada"
    And owner 1 of the session "bea" has committed 1 note
    And owner 1 of the session "bea" crashes after writing the object of its next commit and before the index transaction
    And owner 2 takes over the session "bea"
    When 11 minutes pass
    And the sweeper sweeps every session
    Then the sweeper deleted 2 objects across 2 sessions
    And a cold reader reads 1 note in the session "ada"
    And a cold reader reads 1 note in the session "bea"
