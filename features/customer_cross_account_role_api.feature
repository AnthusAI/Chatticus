Feature: Customer self-setup cross-account role HTTP API
  As a pending organization owner
  I want to submit my AWS account id and RoleArn in-product
  So that provisioning validates the role and enables my organization

  Background:
    Given an empty organization records store
    And the customer self-setup HTTP front door is wired with an in-memory role inspector

  Scenario: A pending owner submits a valid cross-account role
    Given a pending organization owned by "owner@example.com"
    And the in-memory role inspector trusts the organization ExternalId with full permissions
    When the owner submits their AWS account id and RoleArn via HTTP
    Then the self-setup response status is 200
    And the self-setup response accepts the submission
    And that organization is enabled with AWS home recorded
    When GET /me is called with a valid id token for "owner@example.com"
    Then GET /me organizations include one with status "enabled"

  Scenario: ExternalId mismatch returns 422 and leaves the organization pending
    Given a pending organization owned by "owner@example.com"
    And the in-memory role inspector trusts a mismatched ExternalId with full permissions
    When the owner submits their AWS account id and RoleArn via HTTP
    Then the self-setup response status is 422
    And the self-setup response names the ExternalId mismatch and how to correct it
    And that organization stays pending with no AWS home

  Scenario: A role missing required permissions returns 422
    Given a pending organization owned by "owner@example.com"
    And the in-memory role inspector trusts the organization ExternalId without full permissions
    When the owner submits their AWS account id and RoleArn via HTTP
    Then the self-setup response status is 422
    And the self-setup response names the missing permission
    And that organization stays pending with no AWS home

  Scenario: A non-owner member cannot submit a cross-account role
    Given a pending organization owned by "owner@example.com"
    And "member@example.com" is a non-owner member of that organization
    And the in-memory role inspector trusts the organization ExternalId with full permissions
    When "member@example.com" submits the AWS account id and RoleArn via HTTP
    Then the self-setup response status is 403

  Scenario: An owner cannot submit on another organization's path
    Given a pending organization owned by "owner@example.com"
    And a pending organization owned by "other@example.com"
    And the in-memory role inspector trusts the organization ExternalId with full permissions
    When "owner@example.com" submits the AWS account id and RoleArn for the other organization via HTTP
    Then the self-setup response status is 403

  Scenario: Resubmitting on an already enabled organization is refused
    Given a pending organization owned by "owner@example.com"
    And the in-memory role inspector trusts the organization ExternalId with full permissions
    When the owner submits their AWS account id and RoleArn via HTTP
    Then the self-setup response status is 200
    When the owner submits their AWS account id and RoleArn via HTTP
    Then the self-setup response status is 422
    And the self-setup response detail mentions self-setup requires pending

  Scenario: Unauthenticated self-setup is refused
    Given a pending organization owned by "owner@example.com"
    When the self-setup endpoint is called without Authorization
    Then the self-setup response status is 403

  Scenario: An operator bearer cannot submit a cross-account role
    Given a pending organization owned by "owner@example.com"
    And an authenticated operator credential
    When the operator submits the AWS account id and RoleArn via HTTP
    Then the self-setup response status is 403

  Scenario: Operator enable remains break-glass without AWS home
    Given a pending organization owned by "owner@example.com"
    And an authenticated operator credential
    When the operator calls the enable endpoint for that pending organization
    Then the operator response status is 200
    And that pending organization is enabled with no AWS home
