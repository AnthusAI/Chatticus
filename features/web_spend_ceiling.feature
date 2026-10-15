Feature: Workspace UI to raise the monthly AWS spend ceiling
  As an organization owner
  I want to raise the monthly AWS spend ceiling from the product workspace
  So that paused computer work resumes without asking an operator

  Scenario: An owner is offered the raise form while computer work is paused
    Given the enabled workspace web SPA for "owner@example.com" in "Acme Labs"
    And the organization has a monthly spend ceiling of 250 USD and month-to-date spend past it
    When the web SPA reloads membership
    Then the web SPA offers to raise the spend ceiling

  Scenario: An owner raises the ceiling from the workspace and computer work resumes
    Given the enabled workspace web SPA for "owner@example.com" in "Acme Labs"
    And the organization has a monthly spend ceiling of 250 USD and month-to-date spend past it
    When the web SPA raises the spend ceiling to "500"
    Then the web SPA confirms the spend ceiling is now 500
    And the organization ceiling is 500 USD
    And the web SPA no longer shows computer work as paused

  Scenario: An amount that is not positive is blocked before anything is sent
    Given the enabled workspace web SPA for "owner@example.com" in "Acme Labs"
    And the organization has a monthly spend ceiling of 250 USD and month-to-date spend past it
    When the web SPA raises the spend ceiling to "zero dollars"
    Then the web SPA blocks the ceiling change before sending it
    And the organization ceiling is 250 USD

  Scenario: A member who is not an owner is told to ask an owner
    Given the web SPA shows "Acme Labs" as paused for a member
    Then the web SPA tells the member to ask an owner
    And the web SPA does not offer to raise the spend ceiling
