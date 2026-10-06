Feature: A computer whose host was killed is reconciled by the next start
  As a household member
  I want the next turn to start a fresh computer host when the old host vanished
  So that a crash, a spot reclaim or a manual stop never leaves a record claiming a host and a dirty disk that are gone

  Background:
    Given an empty control plane

  Scenario: The next start settles the record of a host killed with a dirty disk
    Given a fenced computer handoff with a queued continuation job
    And the computer has a published snapshot
    And host "doomed-host" is running the computer with unpublished writes and holds the live disk lock
    When host "doomed-host" is killed before it can report
    And a computer-capable pull worker without a host executor pulls that continuation job
    Then the computer record is settled as stopped with no unpublished writes
    And the computer must hydrate the published snapshot
    And the computer record shows the loss of the host of generation 0
    And the host start driver was invoked once

  Scenario: The turn completes on the new host after the old host was killed mid-action
    Given a fenced computer handoff with a queued continuation job
    And the computer has a published snapshot
    And host "doomed-host" is running the computer with unpublished writes and holds the live disk lock
    And host "doomed-host" claimed the pending computer action
    When host "doomed-host" is killed before it can report
    And a computer-capable worker pulls that continuation job
    Then the tool result is committed once
    And the pull worker leaves no unresolved tool calls

  Scenario: The live disk lock of the dead host is released for the new host
    Given a fenced computer handoff with a queued continuation job
    And host "doomed-host" is running the computer with unpublished writes and holds the live disk lock
    When host "doomed-host" is killed before it can report
    And a computer-capable pull worker without a host executor pulls that continuation job
    Then no host holds the live disk lock
    And host "new-host" can take the live disk lock

  Scenario: A computer with no published snapshot has nothing to hydrate
    Given a fenced computer handoff with a queued continuation job
    And host "doomed-host" is running the computer with unpublished writes and holds the live disk lock
    When host "doomed-host" is killed before it can report
    And a computer-capable pull worker without a host executor pulls that continuation job
    Then the computer record is settled as stopped with no unpublished writes
    And the computer does not need to hydrate
    And the computer record shows the loss of the host of generation 0

  Scenario: A record that claims a host no worker ever registered is settled
    Given a fenced computer handoff with a queued continuation job
    And the computer has a published snapshot
    And the computer record claims unpublished writes although no host is registered
    When a computer-capable pull worker without a host executor pulls that continuation job
    Then the computer record is settled as stopped with no unpublished writes
    And the computer must hydrate the published snapshot

  Scenario: A slow host with a fresh heartbeat is not reconciled
    Given a fenced computer handoff with a queued continuation job
    And the computer has a published snapshot
    And host "slow-host" is running the computer with unpublished writes and holds the live disk lock
    When 20 seconds pass and host "slow-host" sends a heartbeat
    And 20 seconds pass
    And a computer-capable pull worker without a host executor pulls that continuation job
    Then the computer is still running with unpublished writes
    And the computer does not need to hydrate
    And the computer record shows no host loss
