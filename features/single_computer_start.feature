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
