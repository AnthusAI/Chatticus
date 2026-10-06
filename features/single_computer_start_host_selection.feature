Feature: Single computer start host selection
  As an organization member
  I want a stale local host passed over when I start my computer
  So that a host that missed a published snapshot never splits the workplace

  Background:
    Given an empty control plane

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
