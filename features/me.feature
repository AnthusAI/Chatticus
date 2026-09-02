Feature: GET /me membership snapshot
  As a signed-in Chatticus user
  I want the SPA to learn my identity and organizations from GET /me
  So that the web UI branches on membership state without a build-time tenant

  Background:
    Given a Cognito-verified HTTP front door

  Scenario: GET /me without Authorization fails closed
    When GET /me is called without Authorization
    Then GET /me responds with status 403

  Scenario: GET /me with an invalid token fails closed
    When GET /me is called with bearer token "not-a-jwt"
    Then GET /me responds with status 403

  Scenario: GET /me with an expired id token fails closed
    Given the me front door has tenant "anthus" enabled for "owner@example.com"
    When GET /me is called with an expired id token for "owner@example.com"
    Then GET /me responds with status 403

  Scenario: GET /me with a valid token for an unknown email returns empty membership
    When GET /me is called with a valid id token for "unknown@example.com"
    Then GET /me responds with status 200
    And GET /me email is "unknown@example.com"
    And GET /me user id is empty
    And GET /me organizations are empty

  Scenario: GET /me with a valid token for a signed-in user with no organizations
    Given "sam@example.com" has signed in on the me front door
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me responds with status 200
    And GET /me email is "sam@example.com"
    And GET /me user id is present
    And GET /me organizations are empty

  Scenario: GET /me returns a pending organization
    Given "ryan@example.com" has signed in on the me front door
    And that user has created organization "Anthus Labs"
    When GET /me is called with a valid id token for "ryan@example.com"
    Then GET /me responds with status 200
    And GET /me organizations include one with status "pending"

  Scenario: GET /me returns an enabled organization
    Given the me front door has tenant "anthus" enabled for "owner@example.com"
    When GET /me is called with a valid id token for "owner@example.com"
    Then GET /me responds with status 200
    And GET /me email is "owner@example.com"
    And GET /me user id is present
    And GET /me organizations include:
      | tenant_id | status  |
      | anthus    | enabled |
