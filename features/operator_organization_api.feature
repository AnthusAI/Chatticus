Feature: Authenticated operator enable/suspend API
  As an operator
  I want to enable, suspend, and reinstate organizations through an authenticated API
  So that external callers do not need shell access to the members CLI

  Background:
    Given an empty organization records store
    And the operator HTTP front door is wired with operator key "test-operator-secret"

  Scenario: An authenticated operator enables a pending organization
    Given an organization in pending status
    And an authenticated operator credential
    When the operator calls the enable endpoint for that organization
    Then the organization becomes enabled
    And no computer exists for that organization
    And the same state transition the members CLI produces occurs

  Scenario: An authenticated operator suspends an enabled organization
    Given an organization in enabled status
    And an authenticated operator credential
    When the operator calls the suspend endpoint for that organization
    Then the organization becomes suspended

  Scenario: An authenticated operator reinstates a suspended organization
    Given an organization in enabled status
    And an authenticated operator credential
    And that organization has been suspended
    When the operator calls the reinstate endpoint for that organization
    Then the organization becomes enabled

  Scenario: An unauthenticated caller is rejected
    Given an organization in pending status
    When a request without a valid operator credential calls the enable endpoint
    Then the operator response status is 403
    And the organization status is unchanged

  Scenario: An org owner Cognito JWT cannot enable a pending organization
    Given an organization in pending status for owner "owner@example.com"
    When the owner calls the enable endpoint with a Cognito JWT
    Then the operator response status is 403
    And the organization status is unchanged

  Scenario: A worker bearer cannot enable a pending organization
    Given an organization in pending status
    And a worker registered for that organization
    When the worker calls the enable endpoint with its bearer token
    Then the operator response status is 403
    And the organization status is unchanged

  Scenario: The CloudFront invoke key alone cannot enable an organization
    Given an organization in pending status
    And the HTTP front door requires invoke key "edge-secret"
    When the enable endpoint is called with only the invoke key
    Then the operator response status is 403
    And the organization status is unchanged

  Scenario: An empty operator key refuses even with a bearer
    Given an organization in pending status
    And the operator HTTP front door has no operator key configured
    When the enable endpoint is called with bearer "any-token"
    Then the operator response status is 403
    And the organization status is unchanged

  Scenario: A wrong operator bearer is rejected
    Given an organization in pending status
    When the enable endpoint is called with bearer "wrong-operator-secret"
    Then the operator response status is 403
    And the organization status is unchanged

  Scenario: Invoke key and operator bearer together enable an organization
    Given an organization in pending status
    And the HTTP front door requires invoke key "edge-secret"
    And an authenticated operator credential
    When the operator calls the enable endpoint for that organization
    Then the operator response status is 200
    And the organization becomes enabled

  Scenario: Enabling a non-pending organization is refused
    Given an organization in enabled status
    And an authenticated operator credential
    When the operator calls the enable endpoint for that organization
    Then the operator response status is 409
    And the operator response detail matches the kernel enable transition error

  Scenario: Suspending a non-enabled organization is refused
    Given an organization in pending status
    And an authenticated operator credential
    When the operator calls the suspend endpoint for that organization
    Then the operator response status is 409
    And the operator response detail matches the kernel suspend transition error

  Scenario: Reinstating a non-suspended organization is refused
    Given an organization in enabled status
    And an authenticated operator credential
    When the operator calls the reinstate endpoint for that organization
    Then the operator response status is 409
    And the operator response detail matches the kernel reinstate transition error

  Scenario: Enable is not unsuspend
    Given an organization in enabled status
    And an authenticated operator credential
    And that organization has been suspended
    When the operator calls the enable endpoint for that organization
    Then the operator response status is 409
    And the organization status is suspended
