Feature: Single computer start
  As a household member
  I want concurrent bots to share one computer start
  So that retries or simultaneous turns never create split-brain workplaces

  Background:
    Given an empty control plane

  Scenario: Two turns need a stopped computer
    Given the household computer is stopped
    When two eligible turns request that computer concurrently
    Then the platform issues one host start request
    And both turns wait for the same computer identity
    And at most one live host may write that computer

  Scenario: Repeated host start requests share one claim while fresh
    Given the household computer is stopped
    When a turn requests a host start for that computer
    And the same turn retries the host start request
    Then the platform still has one logical host start

  Scenario: A wedged host start claim expires and can be reclaimed
    Given the household computer is stopped
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
