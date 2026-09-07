Feature: Cross-account provisioning

  Background:
    Given an empty organization records store

  Scenario: Self-setup provisions with no Anthus session
    Given a customer who has run the cross-account template in their own account
    When they submit their AWS account id and role
    Then provisioning proceeds without an assisted session
    And no setup fee is charged

  Scenario: A template run with a mismatched ExternalId says so
    Given a customer whose role trusts a different ExternalId
    When they submit their AWS account id and role
    Then the response names the ExternalId mismatch and how to correct it
    And the organization stays pending

  Scenario: A role missing required permissions says which
    Given a customer whose role lacks a permission provisioning needs
    When they submit their AWS account id and role
    Then the response names the missing permission
    And the organization stays pending

  Scenario: A provisioned organization knows its AWS home
    Given an organization that has completed provisioning
    Then it records the customer AWS account id
    And it records the cross-account role
    And it records whether the account is customer-owned or Anthus-managed

  Scenario: A paid organization awaiting provisioning has no AWS home yet
    Given an organization that has paid but not been provisioned
    Then it records no customer AWS account
    And its status is pending

  Scenario: The role is assumed with the organization ExternalId
    Given an organization with a provisioned cross-account role
    When Chatticus assumes that role
    Then the request carries the ExternalId recorded for that organization

  Scenario: One organization ExternalId does not open another account
    Given two organizations with cross-account roles in different AWS accounts
    When Chatticus attempts the first organization role using the second organization ExternalId
    Then the assume is refused
    And no session is issued

  Scenario: An Anthus-managed organization starts in the deployment account
    Given an Anthus-managed organization homed in the deployment AWS account
    When its computer starts
    Then the instance is launched with deployment credentials
    And AssumeRole is not called
    And no ECS client is opened in a customer account

  Scenario: Compute for an organization runs in the customer account
    Given an organization provisioned into a customer AWS account with a ChatticusComputers stack
    When its computer starts
    Then the instance is launched in the customer account
    And the organization's cross-account role was assumed
    And no compute for that organization runs in the Anthus account

  Scenario: An unreachable customer role refuses rather than falls back
    Given an organization whose cross-account role cannot be assumed
    When its computer is asked to start
    Then the start is refused with a provisioning error
    And no instance is launched in the Anthus account

  Scenario: An organization without an AWS home refuses computer start
    Given an organization that has paid but not been provisioned
    When its computer is asked to start
    Then the start is refused with a provisioning error
    And no instance is launched in the Anthus account

  Scenario: A customer organization without ChatticusComputers gets the stack created then RunTask
    Given an organization provisioned into a customer AWS account without a ChatticusComputers stack
    When its computer is asked to start
    Then Chatticus creates the ChatticusComputers stack in the customer account
    And Anthus grants cross-account ECR pull for the customer account
    And the instance is launched in the customer account
    And no compute for that organization runs in the Anthus account

  Scenario: A customer organization with an existing ChatticusComputers stack only describes it
    Given an organization provisioned into a customer AWS account with a ChatticusComputers stack
    When its computer starts
    Then Chatticus describes the ChatticusComputers stack in the customer account
    And Chatticus does not create the ChatticusComputers stack
    And Anthus grants cross-account ECR pull for the customer account
    And the instance is launched in the customer account
    And no compute for that organization runs in the Anthus account

  Scenario: A missing ChatticusComputers stack refuses with a visible provisioning error
    Given an organization provisioned into a customer AWS account without a ChatticusComputers stack
    And the host starter cannot provision customer infrastructure
    When its computer is asked to start
    Then the start is refused with a provisioning error naming the missing stack
    And no instance is launched in the Anthus account

  Scenario: An unreachable customer role refuses without creating a stack or launching Anthus compute
    Given an organization whose cross-account role cannot be assumed
    When its computer is asked to start
    Then the start is refused with a provisioning error
    And Chatticus does not create the ChatticusComputers stack
    And no instance is launched in the Anthus account

  Scenario Outline: A failed ChatticusComputers stack starts delete and refuses host start
    Given an organization provisioned into a customer AWS account with a failed ChatticusComputers stack in <status> status
    When its computer is asked to start
    Then Chatticus deletes the ChatticusComputers stack in the customer account
    And Chatticus does not create the ChatticusComputers stack
    And the start is refused with a provisioning error
    And no instance is launched in the Anthus account

    Examples:
      | status            |
      | ROLLBACK_FAILED   |
      | ROLLBACK_COMPLETE |
      | CREATE_FAILED     |
      | DELETE_FAILED     |

  Scenario: After delete completes ensure creates the ChatticusComputers stack
    Given an organization provisioned into a customer AWS account whose ChatticusComputers stack was deleted
    When its computer is asked to start
    Then Chatticus creates the ChatticusComputers stack in the customer account
    And the start is refused with a provisioning error
    And no instance is launched in the Anthus account

  Scenario: After failed stack recovery completes host start runs in the customer account
    Given an organization provisioned into a customer AWS account with a failed ChatticusComputers stack in ROLLBACK_FAILED status
    When its computer is asked to start
    And the ChatticusComputers stack finishes deleting
    And its computer is asked to start
    And the ChatticusComputers stack finishes creating
    When its computer starts
    Then the instance is launched in the customer account
    And no compute for that organization runs in the Anthus account

  Scenario: Denied DeleteStack refuses without Anthus fallback and retries on the next start
    Given an organization provisioned into a customer AWS account with a failed ChatticusComputers stack in ROLLBACK_FAILED status
    And DeleteStack is denied for the customer CloudFormation client
    When its computer is asked to start
    Then the start is refused with a provisioning error
    And Chatticus does not create the ChatticusComputers stack
    And no instance is launched in the Anthus account
    When DeleteStack is allowed for the customer CloudFormation client
    And its computer is asked to start
    Then Chatticus deletes the ChatticusComputers stack in the customer account

  Scenario: A terminal-failed recreate still deletes on the next start
    Given an organization provisioned into a customer AWS account with a failed ChatticusComputers stack in CREATE_FAILED status
    When its computer is asked to start
    Then Chatticus deletes the ChatticusComputers stack in the customer account
    Given the ChatticusComputers stack is terminal-failed in ROLLBACK_FAILED status
    When its computer is asked to start
    Then Chatticus deletes the ChatticusComputers stack in the customer account

  Scenario: A CREATE_COMPLETE stack with legacy outputs starts UpdateStack before RunTask
    Given an organization provisioned into a customer AWS account with a CREATE_COMPLETE ChatticusComputers stack with legacy outputs only
    When its computer is asked to start
    Then Chatticus updates the ChatticusComputers stack in the customer account
    And the start is refused with a provisioning error
    And no instance is launched in the Anthus account
    And Chatticus does not delete the ChatticusComputers stack

  Scenario: After UPDATE_COMPLETE with subnet outputs host start RunTasks in the customer account
    Given an organization provisioned into a customer AWS account with a CREATE_COMPLETE ChatticusComputers stack with legacy outputs only
    When its computer is asked to start
    And the ChatticusComputers stack finishes updating
    When its computer starts
    Then the instance is launched in the customer account
    And no compute for that organization runs in the Anthus account

  Scenario: UPDATE_COMPLETE without subnet outputs refuses with a visible provisioning error
    Given an organization provisioned into a customer AWS account with a ChatticusComputers stack in UPDATE_COMPLETE status without subnet outputs
    When its computer is asked to start
    Then the start is refused with a provisioning error naming incomplete outputs
    And no instance is launched in the Anthus account

  Scenario: UpdateStack no-op succeeds when subnet outputs are already present
    Given an organization provisioned into a customer AWS account with a ChatticusComputers stack
    And UpdateStack reports no changes for the customer CloudFormation client
    When its computer starts
    Then the instance is launched in the customer account
    And no compute for that organization runs in the Anthus account
