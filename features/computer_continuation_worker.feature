Feature: Computer-capable continuation worker
  As a household member
  I want a computer-capable pull worker to continue the same turn from the journal
  So that unresolved tool calls finish exactly once without a standing host

  Background:
    Given an empty control plane

  Scenario: A computer-capable worker executes unresolved tool calls from the journal
    Given a fenced computer handoff with a queued continuation job
    When a computer-capable worker pulls that continuation job
    Then the turn journal records tool.result for the pending action id
    And the pull worker leaves no unresolved tool calls
    And the computer continuation job is removed from the queue

  Scenario: A computer-capable worker refuses a cpu-only job
    Given a fenced computer handoff with a queued continuation job
    When a computer-capable worker is given a cpu-only job for that turn
    Then the computer-capable worker refuses the cpu job
    And the computer continuation job remains queued

  Scenario: A computer-capable pull worker leaves the job queued without a host executor
    Given a fenced computer handoff with a queued continuation job
    When a computer-capable pull worker without a host executor pulls that continuation job
    Then no tool result is committed for the pending action
    And the computer continuation job remains queued
    And the household computer has recorded one host start
    When a computer-capable pull worker without a host executor pulls that continuation job
    Then the household computer has recorded one host start

  Scenario: Orphaned computer ownership expires without a scheduler
    Given a fenced computer handoff with a queued continuation job
    And the pending computer action ran before its lease expired
    When a computer-capable worker pulls that continuation job after the lease dies
    Then the computer was reclaimed by the pull worker
    And the tool result is committed once
    And the pull worker leaves no unresolved tool calls
