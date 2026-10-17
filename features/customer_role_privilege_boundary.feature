Feature: Customer cross-account role cannot escalate privileges
  As a customer organization
  I want the Chatticus role in my AWS account to be unable to grant itself more power
  So that whoever assumes it can only run computers, never create an administrator

  Background:
    Given the published customer cross-account CloudFormation template

  Scenario: The template ships a permissions boundary for computer roles
    Then the template declares a ChatticusComputersBoundary managed policy
    And the boundary grants no IAM, STS, or organization administration actions

  Scenario: Roles can only be created with the boundary attached
    Then every IAM action that creates or changes a computer role is conditioned on the ChatticusComputersBoundary permissions boundary
    And the cross-account role policy does not grant iam:AttachRolePolicy
    And the cross-account role policy does not grant iam:DeleteRolePermissionsBoundary
    And the cross-account role policy does not grant iam:PutRolePermissionsBoundary

  Scenario: The cross-account role cannot rewrite itself
    Then no IAM action that writes a role applies to ChatticusOrganizationComputerRole

  Scenario: Passing a role is limited to ECS tasks and to computer roles
    Then iam:PassRole is limited to ChatticusComputers roles passed to ecs-tasks.amazonaws.com

  Scenario: ECS actions that accept resource scoping are limited to ChatticusComputers resources
    Then ECS actions other than registration and listing are scoped to ChatticusComputers clusters, services, and task definitions

  Scenario: The computer roles in the customer stack carry the boundary
    Given the committed customer ChatticusComputers CloudFormation template
    Then every IAM role in the ChatticusComputers stack names the ChatticusComputersBoundary permissions boundary
