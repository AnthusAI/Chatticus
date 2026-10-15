Feature: Create a named bot from the enabled workspace
  As an enabled organization member
  I want to create a named bot from the workspace UI
  So that I can chat with teammates without the members CLI or a kernel snippet

  Scenario: An enabled member creates a named bot and sees it in the roster
    Given the enabled workspace web SPA for "ryan@example.com" in "Anthus Labs"
    When the web SPA creates bot "Ping"
    Then the web SPA shows create bot confirmation for "Ping"
    And the web SPA workspace roster shows:
      | Ping |

  Scenario: An invited member creates a bot from the workspace
    Given the enabled workspace web SPA for "ryan@example.com" in "Anthus Labs"
    When the web SPA owner of "Anthus Labs" invites "sam@example.com"
    When the web SPA uses a signed-in session for "sam@example.com"
    When the web SPA refreshes membership from GET /me
    And the web SPA renders the membership shell
    When the web SPA creates bot "Helper"
    Then the web SPA workspace roster shows:
      | Helper |

  Scenario: Duplicate bot names show an error and leave the roster unchanged
    Given the enabled workspace web SPA for "ryan@example.com" in "Anthus Labs"
    When the web SPA creates bot "Ping"
    And the web SPA creates bot "Ping"
    Then the web SPA shows a create bot error
    And the web SPA workspace roster shows:
      | Ping |

  Scenario: Empty bot names are blocked before POST /bots
    Given the enabled workspace web SPA for "ryan@example.com" in "Anthus Labs"
    When the web SPA tries to create a bot with an empty name
    Then the web SPA did not call create bot
    And the web SPA workspace roster is empty

  Scenario: POST /bots rejects an empty bot name
    Given the enabled workspace web SPA for "ryan@example.com" in "Anthus Labs"
    When POST /bots is called with an empty name for organization "Anthus Labs"
    Then POST /bots responds with status 400

  Scenario: A pending member does not see the create bot form
    Given a Cognito-verified HTTP front door with open signup wired to the web SPA
    And the web SPA has a signed-in session for "sam@example.com"
    When the web SPA submits organization name "Acme Labs"
    And the web SPA renders the membership shell
    Then the web SPA shows the welcome screen
    And the web SPA does not show the create bot form
