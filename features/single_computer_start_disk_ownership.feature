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

  Scenario: A stale local host cannot win prefer-local until reconciled
    Given a worker registered as:
      | worker_id   | garage-mac-1       |
      | tenant_id   | anthus             |
      | cost_class  | local              |
      | capabilities| computer           |
      | computer_id | household-computer |
    And a worker registered as:
      | worker_id   | fargate-1          |
      | tenant_id   | anthus             |
      | cost_class  | fargate            |
      | capabilities| computer           |
      | computer_id | household-computer |
    And the household computer "household-computer" is stopped
    And the local host last reconciled snapshot generation 1
    And a newer snapshot generation 2 is published on the remote host
    When the platform selects a host to start the computer
    Then the selected host is "fargate-1"
    When the local host reconciles to snapshot generation 2
    And the platform selects a host to start the computer
    Then the selected host is "garage-mac-1"
