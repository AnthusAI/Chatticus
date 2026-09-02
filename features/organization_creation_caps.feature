Feature: Cap organization creation on open signup
  As a Chatticus operator
  I want bounded organization creation writes
  So that open signup cannot be scripted into unbounded DynamoDB and Cognito cost

  Background:
    Given a Cognito-verified HTTP front door with open signup

  Scenario: A new person creates their first organization
    When POST /organizations is called with a valid id token for "sam@example.com" and name "Acme Labs"
    Then POST /organizations responds with status 201
    And POST /organizations body includes tenant_id and status "pending"
    And organization "Acme Labs" has status "pending"
    And "sam@example.com" is an owner member of "Acme Labs"

  Scenario: A second owned organization for the same person is refused
    Given "sam@example.com" has created organization "Acme Labs" via the HTTP front door
    When POST /organizations is called with a valid id token for "sam@example.com" and name "Beta Labs"
    Then POST /organizations responds with status 409
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me responds with status 200
    And GET /me organizations include one with status "pending"

  Scenario: An overlong organization name is refused
    When POST /organizations is called with a valid id token for "sam@example.com" and an overlong organization name
    Then POST /organizations responds with status 400
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me organizations are empty

  Scenario: Organization creation attempts are rate limited after the cap is hit
    Given a Cognito-verified HTTP front door with open signup and organization creation rate limit 2 per hour
    When POST /organizations is called with a valid id token for "sam@example.com" and name "Acme Labs"
    Then POST /organizations responds with status 201
    When POST /organizations is called with a valid id token for "sam@example.com" and name "Beta Labs"
    Then POST /organizations responds with status 409
    When POST /organizations is called with a valid id token for "sam@example.com" and name "Gamma Labs"
    Then POST /organizations responds with status 429
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me responds with status 200
    And GET /me organizations include one with status "pending"

  Scenario: An operator can create a second owned organization when lifting the cap
    Given an empty organization records store
    And "sam@example.com" has signed in
    And that user has created organization "Acme Labs"
    When the members CLI creates organization "Beta Labs" for "sam@example.com" with confirmation
    Then organization "Beta Labs" has status "pending"
    And "sam@example.com" is an owner member of "Beta Labs"
    And listing organizations for that user includes "Acme Labs"
    And listing organizations for that user includes "Beta Labs"
