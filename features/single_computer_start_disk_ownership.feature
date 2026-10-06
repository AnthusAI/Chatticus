Feature: Single computer start with one live disk writer
  As an organization member
  I want one live host to write a computer's disk
  So that a wedged or stale host never splits the workplace

  Background:
    Given an empty control plane

  Scenario: Two turns need a stopped computer
    Given the organization computer is stopped
    When two eligible turns request that computer concurrently
    Then the platform issues one host start request
    And both turns wait for the same computer identity
    And at most one live host may write that computer

  Scenario: A wedged host start claim expires and can be reclaimed
    Given the organization computer is stopped
    And a turn has requested a host start for that computer
    When the host start lease expires without a live writer
    And another turn requests a host start for that computer
    Then the platform has issued two logical host starts
    And the wedged disk write lock is cleared
