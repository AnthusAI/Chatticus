Feature: A bot keeps its own work board through its board tool, without a computer
  As a member of an organization
  I want each bot to track its ongoing work on a board of its own
  So that a bot's commitments survive compaction and restarts, are visible to the people who can see the bot, and are never reported as done without evidence

  DRAFT. Implemented by Milestone 2 (Kanbus epic chatticus-c5f14c) once the Kanbus-side dependencies in
  docs/BOT_BOARDS.md section 9 have landed. This file is not in features/cucumber-features.txt and no step in
  conversation/features-support/steps/ implements it yet. The contract is docs/BOT_BOARDS.md. Related drafts:
  bot_board_access.feature (who may do what), bot_board_task_migration.feature (the cutover from Task items),
  web_bot_boards.feature (the Board tab). Tags: @server (the board tool and the front door against a fake Kanbus
  cloud store that honors the Kanbus rules named below), @kanbus-parent-writes (needs kbs-8283b923, parent and
  dependency writes through the Kanbus API).

  Each bot has one board. The board is one Kanbus project that belongs to the bot, inside its organization; the cards are
  Kanbus issues, with the Kanbus issue model unchanged. Chatticus does not store the cards and does not define their
  format. A bot reaches its board only through the board tool, which calls the front door; the front door checks the
  organization before it asks the Kanbus cloud store. The computer never touches the board and the board tool never
  summons the computer. These scenarios say what the bot and the people around it can observe. They rely on these
  Kanbus rules: a card is an issue with an id of the form {project key}-{uuid}; a card is created only if it is not
  already there; an update or a delete names the revision it expects, and a stale revision is a conflict; a retry that
  repeats an operation id with the same body replays the first result, and the same operation id with a different body is
  refused; a status change must be a move the card type's workflow allows; a card is closed if and only if it has a
  closing time.

  Background:
    Given an empty control plane
    And the organization "Anthus Labs" has the bot "Assistant"
    And the bot "Assistant" has an empty board

  # ---------------------------------------------------------------- the happy path

  @server
  Scenario: A bot creates a card on its own board without summoning the computer
    Given the organization computer is stopped
    When the bot "Assistant" uses the board tool to create a card titled "Pay the electric bill"
    Then the card is on the board of "Assistant"
    And the card has the status "open"
    And the card records "Assistant" as its creator
    And the board tool reports the card as saved
    And no computer was summoned for the board tool

  @server
  Scenario: A new card has the complete Kanbus shape
    When the bot "Assistant" uses the board tool to create a card titled "Pay the electric bill"
    Then the card has an id made of the board's project key, a dash and a version 4 identifier
    And the card has a title, a description, a type, a status, a priority, an assignee and a creator
    And the card has a created time and an updated time in UTC with milliseconds
    And the card has no closing time
    And the card has empty labels, dependencies and comments

  @server
  Scenario: A bot reads one card by its id
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    When the bot "Assistant" uses the board tool to read that card
    Then the board tool returns the card with its title, status, priority, comments and revision

  @server
  Scenario: A bot lists its board and sees only its own cards
    Given the bot "Assistant" has the cards "Pay the electric bill" and "Renew insurance"
    And the bot "Researcher" in the same organization has the card "Read the vendor report"
    When the bot "Assistant" uses the board tool to list its board
    Then the board tool lists "Pay the electric bill" and "Renew insurance"
    And the board tool does not list "Read the vendor report"

  @server
  Scenario: A bot moves a card along the workflow
    Given the bot "Assistant" has a card titled "Pay the electric bill" with the status "open"
    When the bot "Assistant" uses the board tool to move the card to the status "in_progress"
    Then the card has the status "in_progress"
    And the card has a newer updated time
    And the board tool reports the card as saved

  @server
  Scenario: A bot comments on a card
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    When the bot "Assistant" uses the board tool to comment "Waiting for the statement to arrive" on the card
    Then the card has one comment by "Assistant" with the text "Waiting for the statement to arrive"
    And the comment has an identifier and a created time

  @server
  Scenario: A bot changes the title, the description, the priority and the labels of a card
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    When the bot "Assistant" uses the board tool to update the card with the priority 1 and the label "household"
    Then the card has the priority 1
    And the card has the label "household"

  @server
  Scenario: Fields a bot did not touch, and fields Chatticus does not know, are kept
    Given the bot "Assistant" has a card titled "Pay the electric bill" that also carries an extra field written by another Kanbus tool
    When the bot "Assistant" uses the board tool to move the card to the status "in_progress"
    Then the extra field is still on the card with its original value

  # ---------------------------------------------------------------- evidence and reasons

  @server
  Scenario: A card cannot be completed without evidence
    Given the bot "Assistant" has a card titled "Submit taxes" with the status "in_progress"
    When the bot "Assistant" tries to complete the card without evidence
    Then completing the card is refused for missing evidence
    And the card still has the status "in_progress"

  @server
  Scenario: Blank evidence is no evidence
    Given the bot "Assistant" has a card titled "Submit taxes" with the status "in_progress"
    When the bot "Assistant" tries to complete the card with the evidence "   "
    Then completing the card is refused for missing evidence

  @server
  Scenario: A card completes only with evidence from the system acted upon
    Given the bot "Assistant" has a card titled "File the return" with the status "in_progress"
    When the bot "Assistant" completes the card with the evidence "confirmation-id:ret-42"
    Then the card is closed
    And the card has a closing time
    And the card records the outcome "completed"
    And the card records the evidence "confirmation-id:ret-42"

  @server
  Scenario: A card closes with a recorded reason
    Given the bot "Assistant" has a card titled "Renew insurance" with the status "open"
    When the bot "Assistant" closes the card with the reason "household chose another provider"
    Then the card is closed
    And the card has a closing time
    And the card records the outcome "closed"
    And the card records the reason "household chose another provider"

  @server
  Scenario: A card cannot be closed without a reason
    Given the bot "Assistant" has a card titled "Renew insurance" with the status "open"
    When the bot "Assistant" tries to close the card without a reason
    Then closing the card is refused for missing reason
    And the card still has the status "open"

  @server
  Scenario: A bot cannot move a card to a closed status by a plain status change
    Given the bot "Assistant" has a card titled "File the return" with the status "in_progress"
    When the bot "Assistant" uses the board tool to move the card to the status "closed"
    Then the move is refused because a closed card needs evidence or a reason
    And the card still has the status "in_progress"

  @server
  Scenario: A bot that cannot produce evidence blocks the card instead
    Given the bot "Assistant" has a card titled "File the return" with the status "in_progress"
    When the bot "Assistant" uses the board tool to move the card to the status "blocked"
    And the bot "Assistant" uses the board tool to comment "No confirmation page appeared" on the card
    Then the card has the status "blocked"
    And the card is not closed

  @server
  Scenario: A closed card can be reopened and is open again
    Given the bot "Assistant" has a closed card titled "Renew insurance"
    When the bot "Assistant" uses the board tool to reopen the card
    Then the card has the status "open"
    And the card has no closing time

  # ---------------------------------------------------------------- invalid changes

  @server
  Scenario: A status change the workflow does not allow is refused
    Given the bot "Assistant" has a card titled "Pay the electric bill" with the status "open"
    When the bot "Assistant" uses the board tool to move the card to the status "no-such-status"
    Then the board tool reports a validation failure naming the status
    And the card still has the status "open"

  @server
  Scenario: A card with an unknown type or priority is refused
    When the bot "Assistant" uses the board tool to create a card titled "Odd one" with the type "no-such-type"
    Then the board tool reports a validation failure naming the type
    And the board of "Assistant" has no card titled "Odd one"

  @server
  Scenario: A card without a title is refused
    When the bot "Assistant" uses the board tool to create a card with an empty title
    Then the board tool reports a validation failure naming the title

  @server
  Scenario: A card that is not on the board is reported as not found
    When the bot "Assistant" uses the board tool to read the card "no-such-card"
    Then the board tool reports that the card was not found

  @server @kanbus-parent-writes
  Scenario: A bot groups a card under an epic
    Given the bot "Assistant" has an epic titled "Household finances"
    And the bot "Assistant" has a card titled "Pay the electric bill"
    When the bot "Assistant" uses the board tool to move the card under the epic
    Then the card has the epic as its parent
    And the board tool reports the card as saved

  @server @kanbus-parent-writes
  Scenario: A bot moves a card from one parent to another and clears it
    Given the bot "Assistant" has the epics "Household finances" and "Travel"
    And the bot "Assistant" has a card titled "Book flights" under the epic "Household finances"
    When the bot "Assistant" uses the board tool to move the card under the epic "Travel"
    Then the card has the epic "Travel" as its parent
    When the bot "Assistant" uses the board tool to remove the parent of the card
    Then the card has no parent

  @server @kanbus-parent-writes
  Scenario: A parent that does not exist or is at the wrong level is refused
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    When the bot "Assistant" uses the board tool to move the card under the card "no-such-card"
    Then the board tool reports a validation failure naming the parent
    When the bot "Assistant" uses the board tool to move the card under a card of the same level
    Then the board tool reports a validation failure naming the parent hierarchy
    And the card has no parent

  @server @kanbus-parent-writes
  Scenario: A bot records that one card waits on another
    Given the bot "Assistant" has the cards "Pay the electric bill" and "Receive the statement"
    When the bot "Assistant" uses the board tool to record that "Pay the electric bill" depends on "Receive the statement"
    Then the card "Pay the electric bill" lists a dependency on "Receive the statement"

  @server @kanbus-parent-writes
  Scenario: A dependency on a card that does not exist is refused
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    When the bot "Assistant" uses the board tool to record that the card depends on "no-such-card"
    Then the board tool reports a validation failure naming the dependency

  # ---------------------------------------------------------------- concurrent changes

  @server
  Scenario: Two writers of the same card cannot both win
    Given the bot "Assistant" has a card titled "Pay the electric bill" at revision 1
    And an organization owner changes the title of the card to "Pay the water bill" so that it is at revision 2
    When the bot "Assistant" uses the board tool to move the card to the status "in_progress" expecting revision 1
    Then the board tool reports a conflict
    And the conflict names the current revision 2
    And the card keeps the title "Pay the water bill" and the status "open"

  @server
  Scenario: After a conflict the bot reads the card again and applies its change
    Given the bot "Assistant" has a card titled "Pay the electric bill" at revision 1
    And an organization owner changes the title of the card to "Pay the water bill" so that it is at revision 2
    When the bot "Assistant" uses the board tool to move the card to the status "in_progress" expecting revision 1
    And the bot "Assistant" uses the board tool to read that card
    And the bot "Assistant" uses the board tool to move the card to the status "in_progress" expecting revision 2
    Then the card has the status "in_progress"
    And the card keeps the title "Pay the water bill"

  @server
  Scenario: A bot's update without a revision is not applied blindly
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    When the bot "Assistant" uses the board tool to move the card to the status "in_progress" without naming a revision
    Then the board tool reads the card and applies the change to the revision it read
    And the card has the status "in_progress"

  @server
  Scenario: Creating a card is conditional on the card not being there already
    Given the bot "Assistant" has created a card with a chosen identifier
    When another request creates a card with the same identifier
    Then the second creation is a conflict
    And the first card is unchanged

  @server
  Scenario: Deleting a card needs the revision the deleter saw
    Given the bot "Assistant" has a card titled "Pay the electric bill" at revision 3
    When an organization owner deletes the card expecting revision 2
    Then the deletion is a conflict
    And the card is still on the board
    When an organization owner deletes the card expecting revision 3
    Then the card is no longer on the board

  # ---------------------------------------------------------------- retries

  @server
  Scenario: A retried create does not make a second card
    Given the bot "Assistant" creates a card titled "Pay the electric bill" with the operation id "op-1"
    And the network answer to that creation was lost
    When the bot "Assistant" repeats the same creation with the operation id "op-1"
    Then the board of "Assistant" has exactly one card titled "Pay the electric bill"
    And the repeated call returns the same card as the first

  @server
  Scenario: A retried move replays the first result
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    And the bot "Assistant" moved the card to the status "in_progress" with the operation id "op-2"
    When the bot "Assistant" repeats the same move with the operation id "op-2"
    Then the card has the status "in_progress"
    And the card was written once

  @server
  Scenario: An operation id reused for a different change is refused
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    And the bot "Assistant" moved the card to the status "in_progress" with the operation id "op-2"
    When the bot "Assistant" uses operation id "op-2" to move the card to the status "blocked"
    Then the board tool reports that the operation id was used for a different change
    And the card has the status "in_progress"

  @server
  Scenario: A turn that is retried by the worker does not repeat its board writes
    Given the bot "Assistant" runs a turn that creates the card "Pay the electric bill" and then the worker is interrupted
    When the worker retries the same turn
    Then the board of "Assistant" has exactly one card titled "Pay the electric bill"

  # ---------------------------------------------------------------- honest saving and failure

  @server
  Scenario: The bot is told a change is saved only after the store has confirmed it
    When the bot "Assistant" uses the board tool to create a card titled "Pay the electric bill"
    Then the board tool says the card is saved only after the cloud store confirmed the record
    And the transcript does not say the card is saved before that confirmation

  @server
  Scenario: A change that cannot be confirmed is reported as failed
    Given the board store cannot confirm writes
    When the bot "Assistant" uses the board tool to create a card titled "Pay the electric bill"
    Then the board tool reports that the card was not saved
    And the board tool says the change may be retried with the same operation id
    And the bot's reply does not say the card was created

  @server
  Scenario: A change whose answer was lost is checked before it is retried by hand
    Given the board store saved a creation but its answer was lost
    When the bot "Assistant" uses the board tool to read its board
    Then the card is on the board
    And the board tool reports it as saved

  @server
  Scenario: The board store being down does not stall the turn
    Given the board store is unreachable
    When the bot "Assistant" receives "add a card to your board titled Pay the electric bill"
    And the bot "Assistant" runs one computerless worker turn
    Then the turn finishes
    And the bot tells the member that the board is unavailable and the card was not saved

  @server
  Scenario: A saved card that the listing does not show yet is reported as pending
    Given a card was saved but the board's index has not caught up
    When the bot "Assistant" uses the board tool to list its board
    Then the board tool says the listing may be behind
    And reading that card by its id returns the saved card

  @server
  Scenario: A listing that is behind is never presented as the card text
    Given a card was saved but the board's index has not caught up
    When the bot "Assistant" uses the board tool to list its board
    Then the saved text of every card shown comes from the saved record
    And the index is used only to find which cards exist

  # ---------------------------------------------------------------- the boundary

  @server
  Scenario: A bot cannot write to the board of another bot in the same organization
    Given the bot "Researcher" in the same organization has a card titled "Read the vendor report"
    When the bot "Assistant" uses the board tool to move the card of "Researcher" to the status "in_progress"
    Then the board tool is denied
    And the card of "Researcher" is unchanged

  @server
  Scenario: A bot cannot choose a board by naming it
    When the bot "Assistant" uses the board tool and names the board of "Researcher"
    Then the board tool uses the board of "Assistant" and never the named one

  @server
  Scenario: A bot that is not in the organization has no board there
    Given the bot "Outsider" belongs to the organization "Other House"
    When the bot "Outsider" uses the board tool to read the card of "Assistant"
    Then the board tool is denied
    And no card content is returned

  @server
  Scenario: Bot board tools are available to a computerless worker turn
    Given the organization computer is stopped
    When the bot "Assistant" receives "add a card to your board titled Pay the electric bill"
    And the bot "Assistant" runs one computerless worker turn
    Then the card is on the board of "Assistant"
    And no computer continuation job is queued for the turn
    And no computer was summoned for the board tool
