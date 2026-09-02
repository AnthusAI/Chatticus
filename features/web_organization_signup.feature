Feature: Organization signup and welcome in the web SPA
  As a signed-in user on the product hostname
  I want the right screen for my deployment signup mode and pending state
  So that open signup creates an organization and invitation-only deployments refuse it in the UI

  Background:
    Given the web SPA membership module with signup mode "open"

  Scenario: A signed-in user with no organization sees the create form
    Given the web SPA has a signed-in session for "sam@example.com"
    And GET /me reports no organizations for that session
    When the web SPA renders the membership shell
    Then the web SPA shows the create organization form
    And the web SPA does not show the invitation-only panel

  Scenario: Creating an organization shows the welcome screen
    Given a Cognito-verified HTTP front door with open signup wired to the web SPA
    And the web SPA has a signed-in session for "sam@example.com"
    When the web SPA submits organization name "Acme Labs"
    Then the web SPA shows the welcome screen
    And the web SPA does not show a queue position
    And the web SPA does not promise email notification

  Scenario: Invitation-only deployment shows invite messaging without a create form
    Given the web SPA membership module with signup mode "invitation_only"
    And the web SPA has a signed-in session for "sam@example.com"
    And GET /me reports no organizations for that session
    When the web SPA renders the membership shell
    Then the web SPA shows the invitation-only panel
    And the web SPA does not show the create organization form
