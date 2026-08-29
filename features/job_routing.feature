Feature: Prefer-local job routing
  As a household running Chatticus
  I want turns to use local hardware when it is healthy
  So that we do not pay AWS for compute we already have

  Background:
    Given an empty control plane
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer,browser,terminal |
      | computer_id | household-computer |
    And a worker registered as:
      | worker_id   | fargate-1 |
      | tenant_id   | anthus    |
      | cost_class  | fargate   |
      | capabilities| computer,browser,terminal |
      | computer_id | household-computer-aws |

  Scenario: A computer turn prefers the local worker
    When tenant "anthus" enqueues a turn:
      | capabilities | computer,browser |
    Then the turn is assigned to worker "garage-mac-1"

  Scenario: A stale local worker loses to Fargate
    And the heartbeat timeout is 30 seconds
    When 90 seconds pass without a heartbeat from "garage-mac-1"
    And tenant "anthus" enqueues a turn:
      | capabilities | computer,browser |
    Then the turn is assigned to worker "fargate-1"

  Scenario: aws_only never selects the garage Mac
    When tenant "anthus" enqueues a turn:
      | capabilities | computer |
      | policy       | aws_only |
    Then the turn is assigned to worker "fargate-1"

  Scenario: local_only does not fall back to AWS
    When 90 seconds pass without a heartbeat from "garage-mac-1"
    And tenant "anthus" enqueues a turn:
      | capabilities | computer |
      | policy       | local_only |
    Then the turn is not assigned

  Scenario: Missing capabilities are not assigned
    When tenant "anthus" enqueues a turn:
      | capabilities | computer,gpu |
    Then the turn is not assigned
