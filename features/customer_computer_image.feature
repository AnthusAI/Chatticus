Feature: Customer computer image in the organization AWS home

  Background:
    Given an empty organization records store

  Scenario: ChatticusComputers declares a customer ECR repository
    Given an organization provisioned into a customer AWS account without a ChatticusComputers stack
    When its computer is asked to start
    Then Chatticus creates the ChatticusComputers stack in the customer account
    And the committed customer ChatticusComputers template declares an ECR repository
    And CreateStack parameters include only TenantId

  Scenario: Missing dev tag refuses before RunTask
    Given an organization provisioned into a customer AWS account with a ChatticusComputers stack
    And the customer computer repository has no dev tag
    When its computer is asked to start
    Then the start is refused with a provisioning error naming the missing computer image
    And no customer ECS RunTask was attempted
    And Anthus does not grant cross-account ECR pull for the customer account

  Scenario: RunTask uses an image URI in the customer AWS account
    Given an organization provisioned into a customer AWS account with a ChatticusComputers stack
    And the customer computer image tag dev exists
    When its computer starts
    Then the instance is launched in the customer account
    And the RunTask task definition image URI is in the customer AWS account
    And Anthus does not grant cross-account ECR pull for the customer account
    And no compute for that organization runs in the Anthus account

  Scenario: Publishing dev uses the cross-account role ECR push permissions
    Given an organization with a provisioned cross-account role
    And a ChatticusComputers stack with an empty customer ECR repository
    When the customer computer image is published from Anthus dev
    Then the publish used the organization cross-account role
    And the published image URI is in the customer AWS account
