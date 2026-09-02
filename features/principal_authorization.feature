Feature: Principal authorization on the HTTP front door
  As a Chatticus operator
  I want every route to require a principal except explicit exemptions
  So that unauthenticated and cross-organization access is refused

  Scenario: Unauthenticated org user routes are refused
    Given principal enforcement has tenant "anthus" enabled for "owner@example.com"
    When an org user route is called without Authorization
    Then the principal response status is 403

  Scenario: Health stays open without a principal
    Given principal enforcement has tenant "anthus" enabled for "owner@example.com"
    When GET /health is called
    Then the principal response status is 200

  Scenario: Authentication routes stay open without a principal
    Given principal enforcement has tenant "anthus" enabled for "owner@example.com"
    When GET /auth/callback is called
    Then the principal response status is 404

  Scenario: Enabled members reach org user routes with a Cognito token
    Given principal enforcement has tenant "anthus" enabled for "owner@example.com"
    When an org user route is called for tenant "anthus" with Authorization
    Then the principal response status is 200

  Scenario: Cross-organization access is refused
    Given principal enforcement has tenant "anthus" enabled for "owner@example.com"
    When an org user route is called for tenant "other-household" with a token for "owner@example.com"
    Then the principal response status is 403

  Scenario: Waitlisted members are refused on enabled-only org routes
    Given principal enforcement has tenant "anthus" pending for "owner@example.com"
    When an org user route is called for tenant "anthus" with a token for "owner@example.com"
    Then the principal response status is 403

  Scenario: GET /me is waitlist-safe for pending members
    Given principal enforcement has tenant "anthus" pending for "owner@example.com"
    When GET /me is called with a valid id token for "owner@example.com"
    Then GET /me responds with status 200
