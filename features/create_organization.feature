Feature: Create an organization from the product
  As someone who signed in with Google
  I want to name my organization on an open-signup deployment
  So that it is ready to use at once, hosted in the Chatticus deployment's own AWS account, without asking me for an AWS account

  A new organization is enabled when it is created and homed in the deployment
  account as Anthus-managed. Its bots and its computer run in the account the
  deployment already runs in. Nothing in onboarding asks for an AWS account;
  connecting a customer-owned account is a separate, optional path.

  Background:
    Given a Cognito-verified HTTP front door with open signup

  Scenario: A new person creates an organization and it is enabled in the deployment account
    When POST /organizations is called with a valid id token for "sam@example.com" and name "Acme Labs"
    Then POST /organizations responds with status 201
    And POST /organizations body includes tenant_id and status "enabled"
    And organization "Acme Labs" has status "enabled"
    And organization "Acme Labs" is homed in the deployment account as Anthus-managed
    And "sam@example.com" is an owner member of "Acme Labs"
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me responds with status 200
    And GET /me user id is present
    And GET /me organizations include:
      | name      | status  |
      | Acme Labs | enabled |

  Scenario: A newly created organization sends a message to a bot without providing an AWS account
    Given "sam@example.com" has created organization "Acme Labs" via the HTTP front door
    When "sam@example.com" creates bot "Pilot" in organization "Acme Labs" via the HTTP front door
    Then POST /bots responds with status 200
    When "sam@example.com" opens a direct channel with bot "Pilot" in organization "Acme Labs" via the HTTP front door
    And "sam@example.com" sends "Hello" to bot "Pilot" in organization "Acme Labs" via the HTTP front door
    Then the message post responds with status 200 and starts a turn
    And organization "Acme Labs" is homed in the deployment account as Anthus-managed

  Scenario: An operator lists the enabled organization after product signup
    Given "sam@example.com" has created organization "Acme Labs" via the HTTP front door
    When the members CLI lists organizations with status "enabled"
    Then the members CLI output includes organization "Acme Labs"

  Scenario: Invitation-only deployment refuses organization creation
    Given a Cognito-verified HTTP front door with invitation-only signup
    And "sam@example.com" has signed in on the me front door
    When POST /organizations is called with a valid id token for "sam@example.com" and name "Acme Labs"
    Then POST /organizations responds with status 403
    When GET /me is called with a valid id token for "sam@example.com"
    Then GET /me organizations are empty

  Scenario: An already-enabled member of an invitation-only deployment signs in and uses the workspace
    Given a Cognito-verified HTTP front door with invitation-only signup
    And "ryan@example.com" has signed in on the me front door
    And that user has created and enabled organization "Anthus Labs"
    When GET /me is called with a valid id token for "ryan@example.com"
    Then GET /me responds with status 200
    And GET /me organizations include one with status "enabled"
    When "ryan@example.com" creates bot "Pilot" in organization "Anthus Labs" via the HTTP front door
    Then POST /bots responds with status 200
    When "ryan@example.com" opens a direct channel with bot "Pilot" in organization "Anthus Labs" via the HTTP front door
    And "ryan@example.com" sends "Hello" to bot "Pilot" in organization "Anthus Labs" via the HTTP front door
    Then the message post responds with status 200 and starts a turn
