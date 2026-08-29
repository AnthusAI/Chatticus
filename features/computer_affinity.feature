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
      | computer_id | household-computer-aws |

  Scenario: A pinned turn stays on the named computer
    When tenant "anthus" enqueues a turn:
      | capabilities | computer |
      | computer_id  | household-computer-aws |
    Then the turn is assigned to worker "fargate-1"

  Scenario: A pin to an offline computer is not reassigned
    When 90 seconds pass without a heartbeat from "garage-mac-1"
    And tenant "anthus" enqueues a turn:
      | capabilities | computer |
      | computer_id  | household-computer |
    Then the turn is not assigned
