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
