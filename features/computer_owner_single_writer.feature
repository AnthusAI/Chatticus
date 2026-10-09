Feature: One owner at a time on an organization computer
  As the operator of an organization computer
  I want a turn that needs the computer to wait while an owner is already running on it
  So that two owners never hold two copies of the one disk and race to publish it

  The computer is shared by the whole organization and has one disk snapshot.
  A registered owner with a fresh heartbeat on a computer that is not stopped
  counts as a live host, so a turn that parks on the computer publishes no
  start job and waits. When the owner exits cleanly it marks the computer
  stopped; the next probe of each waiting turn then asks for a start, and the
  starter shares one start between the jobs, so exactly one new owner is
  launched.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Analyst"

  Scenario: A second turn waits for the live owner and is started once it has exited
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
    And 61 seconds pass
    And the turn probe runs
    Then a computer start job is queued for the turn
    When every queued start job is delivered to the starter
    Then the host start driver was invoked once
