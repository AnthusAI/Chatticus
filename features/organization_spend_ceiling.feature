Feature: Organization spend ceiling

  Background:
    Given an empty organization records store

  Scenario: Provisioning records a monthly ceiling
    Given an organization being provisioned into a customer AWS account
    When provisioning completes
    Then the organization carries a monthly AWS spend ceiling

  Scenario: An owner raises the ceiling
    Given an enabled organization with a monthly spend ceiling
    When its owner sets a higher ceiling
    Then the organization carries the new ceiling

  Scenario: A member who is not an owner cannot change the ceiling
    Given an enabled organization with a monthly spend ceiling
    When a member who is not an owner attempts to change it
    Then the change is refused
    And the ceiling is unchanged
