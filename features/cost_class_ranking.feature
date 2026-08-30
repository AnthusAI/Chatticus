Feature: Cost-class ranking
  As a household running Chatticus
  I want cheaper healthy workers chosen first
  So that local beats a warm EC2 computer, which beats Fargate

  Scenario: Stop-start EC2 beats Fargate when local is absent
    Given an empty control plane
    And a worker registered as:
      | worker_id   | fargate-1 |
      | tenant_id   | anthus    |
      | cost_class  | fargate   |
      | capabilities| computer  |
    And a worker registered as:
      | worker_id   | ec2-1 |
      | tenant_id   | anthus |
      | cost_class  | ec2    |
      | capabilities| computer |
    When tenant "anthus" enqueues a turn:
      | capabilities | computer |
    Then the turn is assigned to worker "ec2-1"

  Scenario: Local still beats a warm EC2 computer
    Given an empty control plane
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer     |
    And a worker registered as:
      | worker_id   | ec2-1 |
      | tenant_id   | anthus |
      | cost_class  | ec2    |
      | capabilities| computer |
    When tenant "anthus" enqueues a turn:
      | capabilities | computer |
    Then the turn is assigned to worker "garage-mac-1"

  Scenario: aws_only may choose EC2
    Given an empty control plane
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer     |
    And a worker registered as:
      | worker_id   | ec2-1 |
      | tenant_id   | anthus |
      | cost_class  | ec2    |
      | capabilities| computer |
    When tenant "anthus" enqueues a turn:
      | capabilities | computer |
      | policy       | aws_only |
    Then the turn is assigned to worker "ec2-1"
