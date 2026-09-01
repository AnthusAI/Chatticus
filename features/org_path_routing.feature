Feature: Organization path routing
  As a Chatticus operator
  I want the organization carried in the request path
  So that every request states which organization it is for

  Scenario: Org-scoped routes live under /orgs/{tenant_id}
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When the front door receives POST /orgs/anthus/channels for user "ryan" with bots:
      | Researcher |
    Then the channel response has tenant_id "anthus"

  Scenario: X-Tenant-Id is rejected at the front door
    Given an empty control plane
    When the front door receives GET /orgs/anthus/users/ryan/bots with header X-Tenant-Id anthus
    Then the front door rejects X-Tenant-Id

  Scenario: Another tenant cannot post on the channel via the wrong org path
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    When tenant "other" posts "intrusion" on the channel via org path "other-household"
    Then posting fails because the tenant does not match
    And the channel has 0 messages

  Scenario: Health stays outside the org path
    Given a front door serving named environment "development" with HTTP
    Then GET /health reports environment "development"

  Scenario: Authentication routes stay outside the org path
    Then "/auth/callback" is outside the principal marker system

  Scenario: GET /me stays outside the org path
    Then "/me" is a named waitlist-safe route
