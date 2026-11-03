Feature: Members administrator CLI sets up external email
  As a Chatticus operator
  I want to choose an organization's mail handle, bind a bot to an email address and link a sender from the command line
  So that I can set up external email for an organization without an owner credential

  The commands perform the same operations as the owner routes, through the same binding service, so every refusal the
  owner would see is refused here too.

  Background:
    Given an empty control plane
    And external channels are configured for this environment with the mail domain "mail.scenario.invalid"
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Anthus Labs" has the bot "Researcher"

  Scenario: Set the mail handle, bind a bot to its address and link a sender
    When the members CLI sets the mail handle "anthus" for "Anthus Labs"
    Then the members CLI reports the mail handle "anthus" for "Anthus Labs"
    When the members CLI binds the email address of the bot "Researcher" in "Anthus Labs"
    Then the members CLI reports the bound address "researcher@anthus.mail.scenario.invalid"
    And the organization "Anthus Labs" has an enabled email binding at "researcher@anthus.mail.scenario.invalid" for the bot "Researcher"
    When the members CLI links the email address "SAM@home.example.test" to "sam@example.com" in "Anthus Labs"
    Then the members CLI reports the linked identity "sam@home.example.test" for "sam@example.com" in "Anthus Labs"

  Scenario: Binding an email address needs a mail handle first
    When the members CLI binds the email address of the bot "Researcher" in "Anthus Labs"
    Then the members CLI refused the command with the reason "mail_handle_required"

  Scenario: A reserved mail handle is refused
    When the members CLI sets the mail handle "postmaster" for "Anthus Labs"
    Then the members CLI refused the command with the reason "mail_handle_reserved"

  Scenario: Only a member of the organization can be linked to an address
    When the members CLI links the email address "stranger@home.example.test" to "olive@example.org" in "Anthus Labs"
    Then the members CLI refused the command with the reason "member_not_found"

  Scenario: The commands refuse to run without confirmation when stdin is not a terminal
    When the members CLI sets the mail handle "anthus" for "Anthus Labs" without confirmation
    Then the members CLI refused the command
    And the organization "Anthus Labs" has no mail handle
