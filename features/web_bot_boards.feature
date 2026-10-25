Feature: Members pick between the project boards of the computer and the internal boards of the bots in the Board tab
  As a member of an organization
  I want the Board tab to show what each bot is tracking for itself next to the Kanbus projects in the computer's workspace
  So that I can see a bot's commitments, in columns by status, without asking in chat and without turning the computer on

  DRAFT. The read-only scenarios (the picker, the board drawn by Kanbus, states) moved to the registered
  features/web_bot_board_picker.feature. What remains here is the owner editing, the card detail and the layout scenarios:
  editing needs the owner write UI (a later phase), card detail needs card selection (the first slice passes no selection
  handler), and the layout scenarios about columns and touch need a real browser (the review screenshot gallery covers them for now). Where the list of boards sits (beside the board, or a bottom sheet) moved to the registered feature. Implemented by Milestone 2 (Kanbus epic chatticus-c5f14c) once the Kanbus-side dependencies in
  docs/BOT_BOARDS.md section 9 have landed. This file is not in features/cucumber-features.txt and no step in
  conversation/features-support/steps/ implements it yet. The contract is docs/BOT_BOARDS.md. Related drafts:
  bot_board_tool.feature, bot_board_access.feature, bot_board_task_migration.feature. Tag: @web (the real Board
  controller and the real rendered panel, including the Kanbus component, against a fake front door, a fake Kanbus
  cloud store and a fake running computer, with a fixed clock, as features/web_kanbus_board.feature does).

  The Board tab has a picker with two sections. Project boards are the Kanbus projects in the files of the organization
  computer's workspace, drawn from the issue files as features/web_kanbus_board.feature already tells. Bot boards are the
  internal boards of the organization's bots, read through the front door from the Kanbus cloud store. Both are drawn by
  the same component, IssueCollection from @kanbus/ui, with the same themes; the panel supplies only the cards and the
  configuration the board store holds. A bot board needs no computer. Every member who can see a bot sees its board; the
  panel changes cards, and deletes them, only for the owners and no one else. A closed card has the one closed status and
  records whether it was completed or abandoned. A view across all the bots of an organization is wanted later and is
  not a priority; this file does not specify it. When a bot is deleted its board is archived and leaves the picker.

  # ---------------------------------------------------------------- the picker

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
  Scenario: A bot board that is gone says so
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the member picked the bot board "Assistant" in an earlier visit
    And the bot "Assistant" has since been deleted
    When the member opens the Board tab
    Then the board says "That bot board is no longer there"
    And the picker no longer lists "Assistant"
    And the board of "Assistant" is archived and the board store refuses writes to it

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
  Scenario: An owner deletes a card after confirming
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And "ryan@example.com" is an owner
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    And the member opens the card "Pay the electric bill"
    Then the card offers to delete it
    When the member chooses to delete the card
    Then the board asks the member to confirm the deletion
    When the member confirms
    Then the board does not show the card "Pay the electric bill"

  @web
  Scenario: A member who is not an owner cannot delete a card
    Given the board view for "sam@example.com" in "Anthus Labs" with a running computer
    And "sam@example.com" is a member and not an owner
    And the bot "Assistant" has a board with the card "Renew insurance"
    When the member picks the bot board "Assistant"
    And the member opens the card "Renew insurance"
    Then the card does not offer to delete it

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
  Scenario: On a phone one column at a time fits the screen
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer on a phone-width screen
    And the bot "Assistant" has a board with the card "Pay the electric bill"
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
  Scenario: On an iPad the columns are side by side
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer on an iPad-width screen
    And the bot "Assistant" has a board with the card "Pay the electric bill"
    When the member picks the bot board "Assistant"
    Then at least three columns are visible at once
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
