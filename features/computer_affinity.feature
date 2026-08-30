Feature: Computer affinity
  As a Chatticus user
  I want turns that need cookies and files to stick to one workplace
  So that a bot can continue signed-in work on the same computer

  Background:
    Given an empty control plane
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer,browser |
      | computer_id | household-computer |
    And a worker registered as:
      | worker_id   | fargate-1 |
      | tenant_id   | anthus    |
      | cost_class  | fargate   |
      | capabilities| computer,browser |
      | computer_id | household-computer |

  Scenario: A pinned turn prefers the local host of that computer
    When tenant "anthus" enqueues a turn:
      | capabilities | computer |
      | computer_id  | household-computer |
    Then the turn is assigned to worker "garage-mac-1"

  Scenario: A pin fails over to Fargate when the local host is stale
    When 90 seconds pass without a heartbeat from "garage-mac-1"
    And tenant "anthus" enqueues a turn:
      | capabilities | computer |
      | computer_id  | household-computer |
    Then the turn is assigned to worker "fargate-1"

  Scenario: A pin to a computer with no healthy host is not assigned
    When 90 seconds pass
    And tenant "anthus" enqueues a turn:
      | capabilities | computer |
      | computer_id  | household-computer |
    Then the turn is not assigned
