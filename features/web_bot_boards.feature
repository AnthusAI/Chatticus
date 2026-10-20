Feature: Members pick between the project boards of the computer and the internal boards of the bots in the Board tab
  As a member of an organization
  I want the Board tab to show what each bot is tracking for itself next to the Kanbus projects in the computer's workspace
  So that I can see a bot's commitments, in columns by status, without asking in chat and without turning the computer on

  DRAFT. Implemented by Milestone 2 (Kanbus epic chatticus-c5f14c) once the Kanbus-side dependencies in
  docs/BOT_BOARDS.md section 9 have landed. This file is not in features/cucumber-features.txt and no step in
  conversation/features-support/steps/ implements it yet. The contract is docs/BOT_BOARDS.md. Related drafts:
  bot_board_tool.feature, bot_board_access.feature, bot_board_task_migration.feature. Tag: @web (the real Board
  controller and the real rendered panel, including the Kanbus component, against a fake front door, a fake Kanbus
  cloud store and a fake running computer, with a fixed clock, as features/web_kanbus_board.feature does).

  The Board tab has a picker with two sections. Project boards are the Kanbus projects in the files of the organization
  computer's workspace, drawn from the issue files as features/web_kanbus_board.feature already tells. Bot boards are the
  internal boards of the organization's bots, read through the front door from the Kanbus cloud store. Both are drawn by
  the same component, IssueCollection from @kanbus/ui, with the same themes; the panel supplies only the cards and a
  configuration. A bot board needs no computer. The panel reads for every member and changes cards only for the people
  bot_board_access.feature allows.

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
    And the board says it is a project board
    When the member picks the bot board "Assistant"
    Then the board is named "Assistant's board"
    And the board says it is a bot board

  @web
  Scenario: Switching boards never mixes cards
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    Then the board shows the card "Pay the electric bill"
    And the board does not show the card "Write the guide"
    When the member picks the project board "chatticus"
    Then the board shows the card "Write the guide"
    And the board does not show the card "Pay the electric bill"

  @web
  Scenario: The picker starts where the member left off
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the member picked the bot board "Assistant" in an earlier visit
    When the member opens the Board tab
    Then the bot board "Assistant" is picked
    And the board shows the card "Pay the electric bill"

  @web
  Scenario: A bot with an empty board is still listed, with an empty board
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has an empty board
    When the member picks the bot board "Assistant"
    Then the board says "Assistant has nothing on its board yet"
    And the board has no cards

  @web
  Scenario: A new bot appears in the bot boards section
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    When the owner creates the bot "Scout"
    And the member opens the board picker
    Then the picker has the section "Bot boards" listing "Scout"

  @web
  Scenario: A bot board is listed in an organization with no computer workspace project
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace holds the file "notes/plan.md" containing "no board here"
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member opens the board picker
    Then the picker has the section "Project boards" saying "No Kanbus project in the workspace yet"
    And the picker has the section "Bot boards" listing "Assistant"

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
  Scenario: A bot board is drawn by the same component as a project board
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    When the member picks the project board "chatticus"
    And the member picks the bot board "Assistant"
    Then both boards were drawn by IssueCollection from @kanbus/ui
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

  @web
  Scenario: A card shows how it was closed and the evidence or the reason
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a completed card "File the return" with the evidence "confirmation-id:ret-42"
    And the bot "Assistant" has a closed card "Renew insurance" with the reason "household chose another provider"
    When the member picks the bot board "Assistant"
    And the member opens the card "File the return"
    Then the card says it was completed
    And the card shows the evidence "confirmation-id:ret-42"
    When the member opens the card "Renew insurance"
    Then the card says it was closed
    And the card shows the reason "household chose another provider"

  @web
  Scenario: A card shows its comments and who wrote them
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a card "Pay the electric bill" with the comment "Waiting for the statement" by "Assistant"
    When the member picks the bot board "Assistant"
    And the member opens the card "Pay the electric bill"
    Then the card shows the comment "Waiting for the statement" by "Assistant"

  @web
  Scenario: The bot board works with the computer off
    Given the board view for "ryan@example.com" in "Anthus Labs" with the computer switched off
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    Then the board shows the card "Pay the electric bill"
    And the board does not say "Computer is off"
    And the computer was not started to show the board

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
    Then the board shows the card "Renew insurance"

  @web
  Scenario: A board larger than the limit shows the most recently changed cards and says so
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has 230 cards on its board
    When the member picks the bot board "Assistant"
    Then the board says "Showing the 200 most recently changed of 230 issues"

  # ---------------------------------------------------------------- saving, failing, lagging

  @web
  Scenario: Moving a card shows saving, then saved
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the board store takes a moment to confirm a write
    When the member picks the bot board "Assistant"
    And the member moves the card "Pay the electric bill" to the column "in_progress"
    Then the card says "Saving"
    When the board store confirms the write
    Then the card says "Saved"
    And the board column "in_progress" lists "Pay the electric bill"

  @web
  Scenario: A move that fails puts the card back and says so
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the board store cannot confirm writes
    When the member picks the bot board "Assistant"
    And the member moves the card "Pay the electric bill" to the column "in_progress"
    Then the card says "Failed to save"
    And the board column "open" lists "Pay the electric bill"
    And the card offers to try again

  @web
  Scenario: Trying again after a failure repeats the same operation once
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    And the board store cannot confirm writes
    When the member picks the bot board "Assistant"
    And the member moves the card "Pay the electric bill" to the column "in_progress"
    And the board store confirms writes again
    And the member tries again
    Then the card says "Saved"
    And the card was written once

  @web
  Scenario: A card that someone else changed first says so instead of overwriting
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    And the bot "Assistant" moves the card "Pay the electric bill" to the status "blocked"
    And the member moves the card "Pay the electric bill" to the column "in_progress"
    Then the card says "Changed by someone else"
    And the board column "blocked" lists "Pay the electric bill"
    And the card offers to show the current card

  @web
  Scenario: A board that is behind says so and does not show conflicting text
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" saved the card "Renew insurance" but the board's index has not caught up
    When the member picks the bot board "Assistant"
    Then the board says "Some recent changes may not be shown yet"
    And the board offers to refresh
    When the board's index catches up
    And the member refreshes the board
    Then the board shows the card "Renew insurance"
    And the board does not say "Some recent changes may not be shown yet"

  @web
  Scenario: A board whose cloud store is unreachable says so in plain words
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the board store is unreachable
    When the member picks the bot board "Assistant"
    Then the board says "The bot boards are not available right now"
    And the board offers to try again
    And the project boards of the computer are still available in the picker

  @web
  Scenario: A bot board that is gone says so
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the member picked the bot board "Assistant" in an earlier visit
    And the bot "Assistant" has since been deleted
    When the member opens the Board tab
    Then the board says "That bot board is no longer there"
    And the picker no longer lists "Assistant"

  # ---------------------------------------------------------------- who may change

  @web
  Scenario: An owner can move a card on a bot board
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And "ryan@example.com" is an owner
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    Then the cards can be moved between columns
    And the board offers to add a card

  @web
  Scenario: A member who is not an owner sees a read-only board
    Given the board view for "sam@example.com" in "Anthus Labs" with a running computer
    And "sam@example.com" is a member and not an owner
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    Then the board shows the card "Pay the electric bill"
    And the board says it is read-only
    And the cards cannot be moved between columns
    And the board does not offer to add a card
    And the board offers no comment box

  @web
  Scenario: Evidence and reasons are asked for when an owner completes or closes a card
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "File the return" in the column "in_progress"
    When the member picks the bot board "Assistant"
    And the member moves the card "File the return" to the column "closed"
    Then the board asks whether the card was completed or closed
    When the member chooses completed without giving evidence
    Then the board says evidence is needed to complete a card
    And the card is still in the column "in_progress"
    When the member chooses completed and gives the evidence "confirmation-id:ret-42"
    Then the card says "Saved"
    And the board column "closed" lists "File the return"
    And the card shows the evidence "confirmation-id:ret-42"

  @web
  Scenario: Closing a card without a reason is not allowed from the board either
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Renew insurance" in the column "open"
    When the member picks the bot board "Assistant"
    And the member moves the card "Renew insurance" to the column "closed"
    And the member chooses closed without giving a reason
    Then the board says a reason is needed to close a card
    And the card is still in the column "open"

  @web
  Scenario: The project board of the computer is still read-only
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    When the member picks the project board "chatticus"
    Then the board says it is read-only
    And the cards cannot be moved between columns

  # ---------------------------------------------------------------- phone and iPad

  @web @phone
  Scenario: On a phone the picker and one column at a time fit the screen
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer on a phone-width screen
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member opens the board picker
    Then the picker fits the screen without sideways scrolling
    When the member picks the bot board "Assistant"
    Then the board shows one column at a time and offers the other columns
    And no part of the board needs sideways scrolling of the page

  @web @phone
  Scenario: On a phone a card opens full screen and has a back control
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer on a phone-width screen
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    And the member opens the card "Pay the electric bill"
    Then the card fills the screen
    And a back control returns to the board

  @web @phone
  Scenario: On a phone a card is moved with a menu, not by dragging
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer on a phone-width screen
    And "ryan@example.com" is an owner
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    And the member opens the card "Pay the electric bill"
    And the member chooses the status "in_progress" from the status menu
    Then the card says "Saved"

  @web @ipad
  Scenario: On an iPad the picker sits beside the board and the columns are side by side
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer on an iPad-width screen
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    Then the picker is shown beside the board
    And at least three columns are visible at once
    And no part of the board needs sideways scrolling of the page

  @web @ipad
  Scenario: On an iPad cards can be dragged between columns by an owner
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer on an iPad-width screen
    And "ryan@example.com" is an owner
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    And the member drags the card "Pay the electric bill" to the column "in_progress" with touch
    Then the card says "Saved"
    And the board column "in_progress" lists "Pay the electric bill"

  @web
  Scenario: The board follows the dark and the light theme
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    And the theme is switched to dark
    Then the board uses the dark theme tokens
    And the board uses no color outside the brand tokens
