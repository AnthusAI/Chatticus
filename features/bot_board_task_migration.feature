Feature: Every existing Task item moves to its bot's board and the Task item is gone
  As an owner of an organization
  I want the work my bots already track as Task items to appear on their boards, with its evidence and reasons, in one cutover
  So that nothing a bot has promised is lost, the evidence-to-complete rule is not weakened, and there is one place for a bot's work and not two

  DRAFT. Implemented by Milestone 2 (Kanbus epic chatticus-c5f14c). This file is not in features/cucumber-features.txt
  and no step in conversation/features-support/steps/ implements it yet. The contract is docs/BOT_BOARDS.md section 8.
  Related drafts: bot_board_tool.feature, bot_board_access.feature, web_bot_boards.feature. Tags: @migration (the
  one-time migration command against an in-memory Task store and a fake Kanbus cloud store), @server (the front door and
  the tool after the cutover).

  Today a Task item is a DynamoDB record with a title, a status of open, blocked, completed or closed, the evidence of
  a completion, the reason of a closing, and the bot that created it (features/thin_task_item.feature,
  features/thin_task_http.feature, features/web_task_list.feature). After the cutover a bot's work is a card on its own
  board (bot_board_tool.feature) and the Task item no longer exists. This is a hard cutover: there is one migration, run
  once per environment, and no period in which both exist, no setting that selects one, and no code that reads both. The
  migration is idempotent so an interrupted run can be run again, and it never deletes a Task item until its card is
  confirmed saved.

  Background:
    Given an empty control plane
    And the organization "Anthus Labs" has the bots "Assistant" and "Researcher"

  # ---------------------------------------------------------------- what moves, and where

  @migration
  Scenario: Every Task item becomes a card on the board of the bot that created it
    Given a Task item "Pay the electric bill" created by "Assistant" with the status "open"
    And a Task item "Read the vendor report" created by "Researcher" with the status "open"
    When the Task items are migrated to the bot boards
    Then the board of "Assistant" has one card titled "Pay the electric bill"
    And the board of "Researcher" has one card titled "Read the vendor report"
    And the board of "Assistant" has no card titled "Read the vendor report"

  @migration
  Scenario: The statuses map onto the board
    Given a Task item "A" created by "Assistant" with the status "open"
    And a Task item "B" created by "Assistant" with the status "blocked"
    And a Task item "C" created by "Assistant" with the status "completed" and the evidence "confirmation-id:ret-42"
    And a Task item "D" created by "Assistant" with the status "closed" and the reason "household chose another provider"
    When the Task items are migrated to the bot boards
    Then the card "A" has the status "open" and is not closed
    And the card "B" has the status "blocked" and is not closed
    And the card "C" is closed and records the outcome "completed"
    And the card "D" is closed and records the outcome "closed"

  @migration
  Scenario: Evidence and reasons are carried over word for word
    Given a Task item "File the return" created by "Assistant" with the status "completed" and the evidence "confirmation-id:ret-42"
    And a Task item "Renew insurance" created by "Assistant" with the status "closed" and the reason "household chose another provider"
    When the Task items are migrated to the bot boards
    Then the card "File the return" records the evidence "confirmation-id:ret-42"
    And the card "Renew insurance" records the reason "household chose another provider"

  @migration
  Scenario: Provenance is carried over
    Given a Task item "Pay the electric bill" created by "Assistant" and last updated by "Researcher"
    When the Task items are migrated to the bot boards
    Then the card "Pay the electric bill" records "Assistant" as its creator
    And the card records that "Researcher" made the last change

  @migration
  Scenario: A migrated card is a valid Kanbus issue
    Given a Task item "Pay the electric bill" created by "Assistant" with the status "open"
    When the Task items are migrated to the bot boards
    Then the card has an id made of the board's project key, a dash and a version 4 identifier
    And the card has every required Kanbus field
    And the card passes the Kanbus validation of its board
    And the card carries the identifier of the Task item it came from

  @migration
  Scenario: A completed or closed card keeps its closing state consistent
    Given a Task item "File the return" created by "Assistant" with the status "completed" and the evidence "confirmation-id:ret-42"
    When the Task items are migrated to the bot boards
    Then the card is closed if and only if it has a closing time

  @migration
  Scenario: The board of a bot is created by the migration when the bot has none yet
    Given the bot "Researcher" has no board yet
    And a Task item "Read the vendor report" created by "Researcher" with the status "open"
    When the Task items are migrated to the bot boards
    Then the bot "Researcher" has a board with one card

  @migration
  Scenario: Tasks of different organizations stay in their own organizations
    Given the organization "Other House" has the bot "Assistant"
    And a Task item "Pay the electric bill" created by "Assistant" of "Anthus Labs"
    And a Task item "Water the plants" created by "Assistant" of "Other House"
    When the Task items are migrated to the bot boards
    Then the board of "Assistant" in "Anthus Labs" has the card "Pay the electric bill" only
    And the board of "Assistant" in "Other House" has the card "Water the plants" only

  # ---------------------------------------------------------------- safety of the migration

  @migration
  Scenario: Running the migration twice makes no duplicate cards
    Given a Task item "Pay the electric bill" created by "Assistant" with the status "open"
    When the Task items are migrated to the bot boards
    And the Task items are migrated to the bot boards again
    Then the board of "Assistant" has exactly one card titled "Pay the electric bill"

  @migration
  Scenario: An interrupted migration continues where it stopped
    Given 5 Task items created by "Assistant"
    And the migration is interrupted after 2 cards are saved
    When the Task items are migrated to the bot boards
    Then the board of "Assistant" has exactly 5 cards
    And every Task item has exactly one card

  @migration
  Scenario: A Task item is removed only after its card is confirmed saved
    Given a Task item "Pay the electric bill" created by "Assistant" with the status "open"
    And the board store cannot confirm writes
    When the Task items are migrated to the bot boards
    Then the migration reports the Task item as not migrated
    And the Task item still exists
    And the board of "Assistant" has no card titled "Pay the electric bill"

  @migration
  Scenario: A Task item that cannot be placed is reported and kept
    Given a Task item "Orphan" with no recorded creating bot
    When the Task items are migrated to the bot boards
    Then the migration reports the Task item "Orphan" as needing a decision
    And the Task item "Orphan" still exists
    And the migration does not guess a bot for it

  @migration
  Scenario: A Task item of a deleted bot is reported and kept
    Given a Task item "Old chore" created by a bot that has since been deleted
    When the Task items are migrated to the bot boards
    Then the migration reports the Task item "Old chore" as needing a decision
    And the Task item "Old chore" still exists

  @migration
  Scenario: A dry run changes nothing and says what would happen
    Given a Task item "Pay the electric bill" created by "Assistant" with the status "open"
    When the migration is run as a dry run
    Then the report says one card would be created on the board of "Assistant"
    And the board of "Assistant" has no cards
    And the Task item still exists

  @migration
  Scenario: The migration reports what it did
    Given 3 Task items created by "Assistant" and 2 created by "Researcher"
    When the Task items are migrated to the bot boards
    Then the report says 5 Task items were migrated
    And the report counts the cards created per bot
    And the report lists the Task items that need a decision

  # ---------------------------------------------------------------- the old way is gone

  @server
  Scenario: After the cutover the task tool is gone from the bot's tools
    Given the Task items have been migrated and the Task item has been retired
    When the model tool list of the bot "Assistant" is built
    Then the tool list has a board tool
    And the tool list has no task tool

  @server
  Scenario: After the cutover the Task item routes are gone
    Given the Task items have been migrated and the Task item has been retired
    When "ryan@example.com" posts the old task tool create action for "Assistant"
    Then the response is not found
    When "ryan@example.com" requests the old task list
    Then the response is not found

  @server
  Scenario: After the cutover no Task record is written or read
    Given the Task items have been migrated and the Task item has been retired
    When the bot "Assistant" uses the board tool to create a card titled "Pay the electric bill"
    Then no Task record was written
    And no Task record was read

  @server
  Scenario: After the cutover the web workspace has no task list
    Given the Task items have been migrated and the Task item has been retired
    When "ryan@example.com" opens the workspace
    Then there is no task list in the workspace
    And the Board tab lists the bot board "Assistant"

  @migration
  Scenario: The Task records are deleted only after the migration was verified
    Given a Task item "Pay the electric bill" created by "Assistant" with the status "open"
    And the Task items have been migrated to the bot boards
    When the migration is verified against the Task items
    Then the verification says every Task item has a card with the same title, status, evidence and reason
    When the Task records are retired
    Then the Task records no longer exist
    And the board of "Assistant" still has the card "Pay the electric bill"

  @migration
  Scenario: Retiring the Task records is refused while a Task item is unmigrated
    Given a Task item "Orphan" with no recorded creating bot
    When the Task records are retired
    Then retiring is refused because a Task item is not migrated
    And the Task item "Orphan" still exists
