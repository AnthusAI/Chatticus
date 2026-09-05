Feature: ECS host starter from environment
  As a computer-queue worker operator
  I want CHATTICUS_HOST_STARTER=ecs to select the ECS RunTask driver
  So that development ThinTurn can summon ephemeral Fargate hosts

  Scenario: CHATTICUS_HOST_STARTER=ecs selects OrganizationComputerHostStarter
    Given CHATTICUS_HOST_STARTER is ecs
    Then the host starter from environment is an OrganizationComputerHostStarter

  Scenario: Without CHATTICUS_HOST_STARTER=ecs the host starter is a no-op
    Given CHATTICUS_HOST_STARTER is not ecs
    And an organization lookup is available for host start
    Then the host starter from environment is a no-op host starter
    When the host starter from environment starts a host
    Then no ECS RunTask was attempted
    And no cross-account AssumeRole was attempted

  Scenario: Development ComputerWorker may tag the summoned task
    Given development ThinTurn ComputerWorker is wired for ECS host start
    Then ComputerWorker IAM allows ecs TagResource on summoned tasks
