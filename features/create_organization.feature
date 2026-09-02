Feature: Create an organization from the product
  As someone who signed in with Google
  I want to name my organization on an open-signup deployment
  So that it lands pending and I see the welcome screen while an operator enables it

  Background:
    Given a Cognito-verified HTTP front door with open signup

  Scenario: A new person creates an organization and membership is pending
    When POST /organizations is called with a valid id token for "sam@example.com" and name "Acme Labs"
    Then POST /organizations responds with status 201
    And POST /organizations body includes tenant_id and status "pending"
    And organization "Acme Labs" has status "pending"
    And "sam@example.com" is an owner member of "Acme Labs"
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me responds with status 200
    And GET /me user id is present
    And GET /me organizations include one with status "pending"

  Scenario: An operator lists the pending organization after product signup
    Given "sam@example.com" has created organization "Acme Labs" via the HTTP front door
    When the members CLI lists organizations with status "pending"
    Then the members CLI output includes organization "Acme Labs"

  Scenario: Invitation-only deployment refuses organization creation
    Given a Cognito-verified HTTP front door with invitation-only signup
    And "sam@example.com" has signed in on the me front door
    When POST /organizations is called with a valid id token for "sam@example.com" and name "Acme Labs"
    Then POST /organizations responds with status 403
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me organizations are empty
