Feature: Worker registration and heartbeats
  As the Chatticus control plane
  I want workers to plug in by pulling, not by inbound SSH
  So that a garage Mac and a Fargate task use the same protocol

  Scenario: A worker registers with tenant, capabilities, and cost class
    Given an empty control plane
    When a worker registers:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer,browser,terminal |
      | computer_id | household-computer |
    Then tenant "anthus" has 1 healthy worker
    And worker "garage-mac-1" has cost class "local"
    And worker "garage-mac-1" has computer affinity "household-computer"

  Scenario: A stale heartbeat makes the worker ineligible
    Given an empty control plane
    And the heartbeat timeout is 30 seconds
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer     |
    When 90 seconds pass without a heartbeat from "garage-mac-1"
    Then tenant "anthus" has 0 healthy workers

  Scenario: A heartbeat keeps the worker eligible
    Given an empty control plane
    And the heartbeat timeout is 30 seconds
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer     |
    When 20 seconds pass
    And worker "garage-mac-1" sends a heartbeat
    And 20 more seconds pass
    Then tenant "anthus" has 1 healthy worker

  Scenario: Re-registering the same worker replaces the advertisement
    Given an empty control plane
    And a worker registered as:
      | worker_id   | household-1 |
      | tenant_id   | anthus      |
      | cost_class  | local       |
      | capabilities| computer    |
      | computer_id | household-computer |
    When a worker registers:
      | worker_id   | household-1 |
      | tenant_id   | anthus      |
      | cost_class  | fargate     |
      | capabilities| computer,browser |
      | computer_id | household-computer |
    Then tenant "anthus" has 1 healthy worker
    And worker "household-1" has cost class "fargate"
    And worker "household-1" has computer affinity "household-computer"
