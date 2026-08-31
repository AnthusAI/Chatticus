Feature: Host computer pull worker
  As a household member
  I want the summoned Fargate host to pull ComputerTurnJobs
  So that Chromium runs on the computer, not on Lambda

  Scenario: ECS RunTask overrides the computer container to the host worker
    Given CHATTICUS_ECS_HOST_COMMAND is the computer host worker module
    When the ECS host starter starts a host for a claim
    Then RunTask overrides that container command
