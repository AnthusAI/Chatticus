Feature: Single computer start
  As an organization member
  I want concurrent bots to share one computer start
  So that retries or simultaneous turns never create split-brain workplaces

  Background:
    Given an empty control plane

  Scenario: Repeated host start requests share one claim while fresh
    Given the organization computer is stopped
    When a turn requests a host start for that computer
    And the same turn retries the host start request
    Then the platform still has one logical host start
