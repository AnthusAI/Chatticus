Feature: Cognito user principal resolution
  As a Chatticus operator
  I want Cognito id_tokens resolved to user principals by verified email
  So that membership and organization status come from DynamoDB, not JWT claims

  # SSE (7b4616): validate once at stream open; reconnect requires fresh token.

  Scenario: A valid Cognito id token resolves to a user principal
    Given tenant "anthus" has an enabled organization for "owner@example.com"
    When the Cognito resolver receives a valid id token for "owner@example.com"
    Then the resolved principal has kind "user"
    And the resolved principal belongs to tenant "anthus"
    And the resolved principal has organization status "enabled"
    And the resolved principal has role "owner"

  Scenario: An expired Cognito token is rejected
    Given tenant "anthus" has an enabled organization for "owner@example.com"
    When the Cognito resolver receives an expired id token for "owner@example.com"
    Then Cognito token resolution fails

  Scenario: A token for an unknown email is rejected
    Given tenant "anthus" has an enabled organization for "owner@example.com"
    When the Cognito resolver receives a valid id token for "unknown@example.com"
    Then identity resolution fails for unknown email

  Scenario: A member of a suspended organization gets a suspended principal
    Given tenant "anthus" has a suspended organization for "owner@example.com"
    When the Cognito resolver receives a valid id token for "owner@example.com"
    Then the resolved principal has organization status "suspended"

  Scenario: Browser routes require a Cognito token
    Given tenant "anthus" has an enabled organization for "owner@example.com"
    When a browser route is called without Authorization
    Then the browser route responds with status 403
