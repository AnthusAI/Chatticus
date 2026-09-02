Feature: Invite people into an enabled organization
  As an organization owner on a spend-approved organization
  I want to invite someone by email and have them join on sign-in
  So that invited members skip the waitlist and invitation-only deployments have a join path

  Background:
    Given a Cognito-verified HTTP front door with open signup

  Scenario: A second person joins an enabled organization by invitation on sign-in
    Given "ryan@example.com" has signed in on the me front door
    And that user has created organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    When the owner of "Anthus Labs" invites "sam@example.com" via the HTTP front door
    Then POST /orgs/invitations responds with status 201
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me responds with status 200
    And GET /me user id is present
    And GET /me organizations include one with status "enabled"
    And GET /me does not include a pending organization
    And "sam@example.com" is a member of "Anthus Labs"

  Scenario: Invitation email matching is case-insensitive on sign-in
    Given "ryan@example.com" has signed in on the me front door
    And that user has created organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    When the owner of "Anthus Labs" invites "SAM@example.com" via the HTTP front door
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me organizations include one with status "enabled"

  Scenario: A member cannot invite by email via the HTTP front door
    Given "ryan@example.com" has signed in on the me front door
    And that user has created organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    When the owner of "Anthus Labs" invites "sam@example.com" via the HTTP front door
    When GET /me is called with a valid id token for "sam@example.com"
    And "sam@example.com" is the current user on the me front door
    When a member of "Anthus Labs" tries to invite "alex@example.com" via the HTTP front door
    Then POST /orgs/invitations responds with status 403

  Scenario: Sign-in with the wrong Google email does not join the organization
    Given "ryan@example.com" has signed in on the me front door
    And that user has created organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    When the owner of "Anthus Labs" invites "sam@example.com" via the HTTP front door
    When GET /me is called with a valid id token for "other@example.com"
    Then GET /me responds with status 200
    And GET /me organizations are empty

  Scenario: An expired invitation is skipped during sign-in reconciliation
    Given "ryan@example.com" has signed in on the me front door
    And that user has created organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    When the owner of "Anthus Labs" invites "sam@example.com" via the HTTP front door
    And the invitation TTL has elapsed
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me responds with status 200
    And GET /me organizations are empty

  Scenario: A pending-organization invitation is skipped during sign-in reconciliation
    Given "ryan@example.com" has signed in on the me front door
    And that user has created organization "Anthus Labs"
    When the owner of "Anthus Labs" invites "sam@example.com" via the HTTP front door
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me responds with status 200
    And GET /me organizations are empty

  Scenario: Invitation-only deployment still refuses organization creation
    Given a Cognito-verified HTTP front door with invitation-only signup
    And "ryan@example.com" has signed in on the me front door
    And that user has created organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    When the owner of "Anthus Labs" invites "sam@example.com" via the HTTP front door
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me organizations include one with status "enabled"
    When POST /organizations is called with a valid id token for "sam@example.com" and name "Other Labs"
    Then POST /organizations responds with status 403

  Scenario: An invited person reaches the enabled workspace in the web SPA
    Given a Cognito-verified HTTP front door with open signup wired to the web SPA
    And "ryan@example.com" has signed in on the me front door
    And that user has created organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    And the web SPA has an enabled organization session for "ryan@example.com" in "Anthus Labs"
    When the web SPA owner of "Anthus Labs" invites "sam@example.com"
    Then the web SPA shows invite confirmation for "sam@example.com"
    Given the web SPA has a signed-in session for "sam@example.com"
    When the web SPA refreshes membership from GET /me
    Then the web SPA shows the enabled workspace
    And the web SPA does not show the welcome screen
