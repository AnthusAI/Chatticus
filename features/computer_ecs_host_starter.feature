Feature: ECS host starter from environment
  As a computer-queue worker operator
  I want CHATTICUS_HOST_STARTER=ecs to select the ECS RunTask driver
  So that development ThinTurn can summon ephemeral Fargate hosts

  Scenario: CHATTICUS_HOST_STARTER=ecs selects EcsHostStarter
    Given CHATTICUS_HOST_STARTER is ecs
    Then the host starter from environment is an ECS host starter
