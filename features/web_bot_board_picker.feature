Feature: Members pick between the project boards of the computer and the boards of the bots in the Board tab
  As a member of an organization
  I want the Board tab to show what each bot is tracking for itself next to the Kanbus projects in the computer's workspace
  So that I can see a bot's commitments, in columns by status, without asking in chat and without turning the computer on

  This is the read-only first slice of the web side of docs/BOT_BOARDS.md section 7. The editing scenarios, the card
  detail scenarios and the layout scenarios stay in the draft features/web_bot_boards.feature. These scenarios run the real
  Board controller and the real rendered panel, including IssueCollection from the Kanbus UI package, against a fake running computer
  that answers the file routes and a fake front door that answers the bot board routes with the shapes of
  conversation/src/http/routes/bot-boards.ts, with a fixed clock (the same harness as features/web_kanbus_board.feature).

  The Board tab has a picker with two sections. Project boards are the Kanbus projects in the files of the organization
  computer's workspace, drawn from the issue files as features/web_kanbus_board.feature tells. Bot boards are the boards of
  the organization's bots, read through the front door. Both are drawn by the same component with the same themes; only
  the source of the cards differs. The board's own configuration (its statuses and workflows) comes from the front door.
  A bot board needs no computer. The panel only reads: it sends no write to a board route.

  # ---------------------------------------------------------------- the picker

  @web
  Scenario: The picker has a section for project boards and a section for bot boards
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the bot "Researcher" has a board with the card "Read the vendor report"
    When the member opens the board picker
    Then the picker has the section "Project boards" listing "chatticus"
    And the picker has the section "Bot boards" listing "Assistant" and "Researcher"

  @web
  Scenario: Each entry says which kind of board it is
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member opens the Board tab
    And the member picks the project board "chatticus"
    Then the board is named "chatticus board"
    And the board says "Project board"
    When the member picks the bot board "Assistant"
    Then the board is named "Assistant's board"
    And the board says "Bot board"

  @web
  Scenario: Switching boards never mixes cards
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    And the bot "Assistant" has a board with these cards
      | id   | title                 | status | priority |
      | as-1 | Pay the electric bill | open   | 1        |
    When the member picks the bot board "Assistant"
    Then the board column "open" lists "as-1"
    When the member picks the project board "chatticus"
    Then the board column "open" lists "cx-2"

  @web
  Scenario: The picker starts where the member left off
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    And the bot "Assistant" has a board with these cards
      | id   | title                 | status | priority |
      | as-1 | Pay the electric bill | open   | 1        |
    And the member picked the bot board "Assistant" in an earlier visit
    When the member opens the Board tab
    Then the board is named "Assistant's board"
    And the board column "open" lists "as-1"

  @web
  Scenario: A bot with an empty board is still listed, with an empty board
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with no cards
    When the member picks the bot board "Assistant"
    Then the board says "Assistant has nothing on its board yet"
    And the board says "0 issues"

  @web
  Scenario: A new bot appears in the bot boards section
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member opens the board picker
    And the bot "Scout" is created with an empty board
    And the member closes and opens the board picker
    Then the picker has the section "Bot boards" listing "Assistant" and "Scout"

  @web
  Scenario: A bot board is listed in an organization with no project in the workspace
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace holds the file "notes/plan.md" containing "no board here"
    And the bot "Assistant" has a board with these cards
      | id   | title                 | status | priority |
      | as-1 | Pay the electric bill | open   | 1        |
    When the member opens the board picker
    Then the picker has the section "Project boards" saying "No Kanbus project in the workspace yet"
    And the picker has the section "Bot boards" listing "Assistant"
    And the board is named "Assistant's board"

  # ---------------------------------------------------------------- a bot board, drawn by Kanbus

  @web
  Scenario: A bot board shows its cards in columns by status
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with these cards
      | id   | title                 | status      | priority | labels    | type | parent |
      | as-1 | Pay the electric bill | in_progress | 1        | household | task | as-0   |
      | as-2 | Renew insurance       | open        | 2        |           | task |        |
      | as-3 | File the return       | closed      | 2        |           | task |        |
      | as-4 | Wait for the vendor   | blocked     | 2        |           | task |        |
    When the member picks the bot board "Assistant"
    Then the board column "open" lists "as-2"
    And the board column "in_progress" lists "as-1"
    And the board column "blocked" lists "as-4"
    And the board column "closed" lists "as-3"
    And the board says "4 issues"

  @web
  Scenario: A bot board uses the statuses its own configuration names
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with these cards
      | id   | title           | status  | priority |
      | as-1 | Renew insurance | backlog | 2        |
    When the member picks the bot board "Assistant"
    Then the board column "backlog" lists "as-1"
    And the board column "closed" lists ""

  @web
  Scenario: A bot board is drawn by the same component as a project board
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    When the member picks the project board "chatticus"
    And the member picks the bot board "Assistant"
    Then both boards were drawn by IssueCollection from the Kanbus UI package
    And both boards use the same card and column markup

  @web
  Scenario: The card shows the title, the id, the priority and the type
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with these cards
      | id   | title                 | status | priority | type |
      | as-1 | Pay the electric bill | open   | 1        | task |
    When the member picks the bot board "Assistant"
    Then the card "as-1" shows "Pay the electric bill"
    And the card "as-1" shows "AS-1"
    And the card "as-1" shows "High"
    And the card "as-1" is a "task" with the priority "High"

  @web
  Scenario: The bot board works with the computer off
    Given the board view for "ryan@example.com" in "Anthus Labs" with the computer switched off
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    Then the board column "open" lists "as-1"
    And the board does not say "Computer is off"
    And the computer was not asked for anything to show the board

  @web
  Scenario: A bot board says that it is saved in the cloud
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    Then the board says "Saved to the cloud"

  @web
  Scenario: A new card that the bot saves appears on refresh
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    And the bot "Assistant" saves the card "Renew insurance"
    And the member refreshes the board
    Then the board says "2 issues"

  @web
  Scenario: The panel only reads a bot board
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    And the member refreshes the board
    Then the panel sent only reads to the bot board routes

  @web
  Scenario: A board larger than the limit shows the first cards and says so
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has 230 cards on its board
    When the member picks the bot board "Assistant"
    Then the board says "Showing the first 200 cards of this board"
    And the board column "open" has a count of 200

  # ---------------------------------------------------------------- lagging, missing, unavailable

  @web
  Scenario: A board that is behind says so and offers to refresh
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the bot board's index has not caught up
    When the member picks the bot board "Assistant"
    Then the board says "Some recent changes may not be shown yet"
    And the board offers to refresh
    When the bot board's index catches up
    And the member refreshes the board
    Then the board does not say "Some recent changes may not be shown yet"

  @web
  Scenario: A board whose cloud store is unreachable says so in plain words
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the bot board store is unreachable
    When the member picks the bot board "Assistant"
    Then the board says "The bot boards are not available right now"
    And the board offers to try again
    When the member opens the board picker
    Then the picker has the section "Project boards" listing "chatticus"

  @web
  Scenario: Trying again after the store was unreachable shows the board
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the bot board store is unreachable
    When the member picks the bot board "Assistant"
    And the bot board store answers again
    And the member refreshes the board
    Then the board column "open" lists "as-1"

  @web
  Scenario: An environment without the board service shows no bot boards and no error
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the environment has no board service
    When the member opens the board picker
    Then the picker has the section "Bot boards" saying "Bot boards are not available in this environment yet"
    And the picker has the section "Project boards" listing "chatticus"
    And the board shows no error

  @web
  Scenario: A bot board that is gone says so
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Researcher" has a board with the card "Read the vendor report"
    And the member picked the bot board "Assistant" in an earlier visit
    When the member opens the Board tab
    Then the board says "That bot board is no longer there"
    When the member opens the board picker
    Then the picker has the section "Bot boards" listing "Researcher"

  @web
  Scenario: A bot board that the front door does not show to this member says so without an error
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the front door answers not found for the board of "Assistant"
    When the member picks the bot board "Assistant"
    Then the board says "This bot board is not available to you"
    And the board shows no error
