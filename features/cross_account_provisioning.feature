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

  Scenario: Compute for an organization runs in the customer account
    Given an organization provisioned into a customer AWS account
    And its customer account has a ChatticusComputers stack
    When its computer starts
    Then the instance is launched in the customer account
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
