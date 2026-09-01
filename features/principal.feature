Feature: Principal seam and waitlist-safe route marker
  As a Chatticus operator
  I want a typed principal and an explicit waitlist-safe route marker
  So that enabled-member routing is default deny without a denylist

  Scenario: A principal carries user or worker kind only
    Given a user principal for tenant "tenant-1"
    Then that principal has kind "user"
    And a worker principal for tenant "tenant-1" has kind "worker"

  Scenario: Unmarked routes require an enabled member by default
    Given an unmarked route handler
    Then that route requires an enabled member

  Scenario: A waitlist-safe route is reachable by a waitlisted member
    Given a route handler marked waitlist-safe
    Then that route does not require an enabled member

  Scenario: GET /me is the waitlist-safe route
  Then "/me" is a named waitlist-safe route

  Scenario: Health and auth routes take no principal
    Then "/health" is outside the principal marker system
    And "/auth/callback" is outside the principal marker system
