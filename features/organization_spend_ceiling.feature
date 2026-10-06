Feature: Organization spend ceiling

  Background:
    Given an empty organization records store

  Scenario: Provisioning records a monthly ceiling
    Given an organization being provisioned into a customer AWS account
    When provisioning completes
    Then the organization carries a monthly AWS spend ceiling
