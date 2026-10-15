Feature: One owner at a time on an organization computer
  As the operator of an organization computer
  I want a turn that needs the computer to wait while an owner is already running on it
  So that two owners never hold two copies of the one disk and race to publish it

  The computer is shared by the whole organization and has one disk snapshot.
  A registered owner with a fresh heartbeat on a computer that is not stopped
  counts as a live host, so a turn that parks on the computer publishes no
  start job and waits. When the owner exits cleanly it marks the computer
  stopped; in that same request the control plane publishes a start job for
  each turn parked on the computer, so the next owner starts at once, and the
  starter shares one start between the jobs, so exactly one new owner is
  launched. The probe of each waiting turn stays as the safety net for a
  stopped report that never arrives.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Analyst"

  Scenario: A second turn waits for the live owner and is started the moment it reports stopped
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/first.md", "content": "one"}
      """
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/second.md", "content": "two"}
      """
    And a recording host start driver
    And host worker "owner-1" serves the household computer
    When bot "Researcher" is asked "save the first file"
    And bot "Researcher" works its turn until it waits for the computer
    And bot "Analyst" is asked "save the second file"
    And bot "Analyst" works its turn until it waits for the computer
    Then the turn is waiting on the workspace gate
    And no computer start job is queued
    When host worker "owner-1" reports the computer stopped as it exits
    Then a computer start job is queued for the turn
    When every queued start job is delivered to the starter
    Then the host start driver was invoked once

  Scenario: Two turns parked behind one owner each get a start job and share one new owner
    Each parked turn gets its own start job, and the starter shares one start
    between them. The turn that did not start the owner waits for that owner to
    exit, and then the same rule starts the next one.

    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/first.md", "content": "one"}
      """
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/second.md", "content": "two"}
      """
    And a recording host start driver
    And host worker "owner-1" serves the household computer
    When bot "Researcher" is asked "save the first file"
    And bot "Researcher" works its turn until it waits for the computer
    And bot "Analyst" is asked "save the second file"
    And bot "Analyst" works its turn until it waits for the computer
    Then no computer start job is queued
    When host worker "owner-1" reports the computer stopped as it exits
    Then 2 computer start jobs are queued
    When every queued start job is delivered to the starter
    Then the host start driver was invoked once

  Scenario: A second stopped report starts no second owner
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/first.md", "content": "one"}
      """
    And a recording host start driver
    And host worker "owner-1" serves the household computer
    When bot "Researcher" is asked "save the first file"
    And bot "Researcher" works its turn until it waits for the computer
    And host worker "owner-1" reports the computer stopped as it exits
    And host worker "owner-1" reports the computer stopped as it exits
    And every queued start job is delivered to the starter
    Then the host start driver was invoked once

  Scenario: A stopped report starts nothing for a finished turn or for another organization
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/first.md", "content": "one"}
      """
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/other.md", "content": "other"}
      """
    And tenant "bolt" user "sam" has a bot named "Outsider"
    And host worker "owner-1" serves the household computer
    And host worker "outsider-owner" serves the computer of tenant "bolt"
    When bot "Researcher" is asked "save the first file"
    And bot "Researcher" works its turn until it waits for the computer
    And the waiting turn is failed with the reason "gave up"
    And bot "Outsider" is asked "save the other file"
    And bot "Outsider" works its turn until it waits for the computer
    And host worker "owner-1" reports the computer stopped as it exits
    Then no computer start job is queued

  Scenario: The probe starts the next owner when the stopped report was lost
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/first.md", "content": "one"}
      """
    And a recording host start driver
    And host worker "owner-1" serves the household computer
    When bot "Researcher" is asked "save the first file"
    And bot "Researcher" works its turn until it waits for the computer
    And the computer is marked stopped without the control plane hearing a report
    Then no computer start job is queued
    When 61 seconds pass
    And the turn probe runs
    Then a computer start job is queued for the turn
    When every queued start job is delivered to the starter
    Then the host start driver was invoked once
