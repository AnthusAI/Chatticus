Feature: A bot keeps its own work board through its board tool, without a computer
  As a member of an organization
  I want each bot to track its ongoing work on a board of its own
  So that a bot's commitments survive compaction and restarts, are visible to the people who can see the bot, and are never reported as done without evidence

  Implemented by Milestone 2 phase 2a (Kanbus epic chatticus-c5f14c): the board service module, the provisioning at bot
  creation and the board tool. The contract is docs/BOT_BOARDS.md. Related drafts: bot_board_access.feature (who may do
  what, over the front door routes), bot_board_task_migration.feature (the cutover from Task items),
  web_bot_boards.feature (the Board tab). Related real features: bot_board_owner_actions.feature (the owner rules inside
  the board service module) and bot_board_rollout.feature (the capability exists only where the board service is
  configured). Tags: @server (the board tool and the board service module against an in-process model of the Kanbus
  board service, which Chatticus reaches only through the published @kanbus/api-client), @kanbus-parent-writes (parent and
  dependency writes through the Kanbus API, kbs-8283b923).

  A new board is provisioned with Kanbus's own default configuration (kbs-344f42ca): the statuses are backlog, open,
  in_progress, blocked and closed, a new card is open, the hierarchy is initiative, epic, task, sub-task, and the types
  include bug, story and chore. Chatticus copies no status list. Where a scenario moves a card between statuses it
  assumes the transitions of the generated configuration; docs/BOT_BOARDS.md lists that as an open question.

  Each bot has one board. The board is one Kanbus project that belongs to the bot, inside its organization; the cards are
  Kanbus issues, with the Kanbus issue model unchanged. Chatticus does not store the cards and does not define their
  format. A bot reaches its board only through the board tool, which calls the front door; the front door checks the
  organization before it asks the Kanbus cloud store. The computer never touches the board and the board tool never
  summons the computer. These scenarios say what the bot and the people around it can observe. They rely on these
  Kanbus rules: a card is an issue with an id of the form {project key}-{uuid}; a card is created only if it is not
  already there; an update or a delete names the revision it expects, and a stale revision is a conflict; a retry that
  repeats an operation id with the same body replays the first result, and the same operation id with a different body is
  refused; a status change must be a move the card type's workflow allows; there is one closed status and a card has it
  if and only if it has a closing time. A card is completed by closing it with a closing comment that holds the evidence
  and the custom field closing set to completed; it is abandoned by closing it with a closing comment that holds the
  reason and closing set to abandoned. A bot closes cards and never deletes them; only an owner deletes. Every call is
  made by the control plane as a service principal naming the acting bot or member in the X-Kanbus-Actor header.

  Background:
    Given an empty control plane
    And the Kanbus board service is configured for this environment
    And the organization "Anthus Labs" has the bot "Assistant"
    And the bot "Assistant" has an empty board

  @server
  Scenario: A new bot board is provisioned with the Kanbus default configuration
    When the bot "Researcher" is created in "Anthus Labs"
    Then the board of "Researcher" was provisioned by an empty-bodied configuration write
    And the configuration of the board is exactly what Kanbus writes for a new project
    And Chatticus supplied no status list
    And the board of "Researcher" accepts the statuses "backlog", "open", "in_progress", "blocked" and "closed"

  # ---------------------------------------------------------------- the happy path

  @server
  Scenario: A bot creates a card on its own board without summoning the computer
    Given the computer of "Anthus Labs" is stopped
    When the bot "Assistant" uses the board tool to create a card titled "Pay the electric bill"
    Then the card is on the board of "Assistant"
    And the card has the status "open"
    And the card records "Assistant" as its creator
    And the store recorded the actor "chatticus:bot:" followed by the identifier of "Assistant"
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
    Then the card has the status "closed"
    And the card has a closing time
    And the card has a closing comment holding the evidence "confirmation-id:ret-42"
    And the card records the closing "completed"

  @server
  Scenario: A card closes with a recorded reason
    Given the bot "Assistant" has a card titled "Renew insurance" with the status "open"
    When the bot "Assistant" closes the card with the reason "household chose another provider"
    Then the card has the status "closed"
    And the card has a closing time
    And the card has a closing comment holding the reason "household chose another provider"
    And the card records the closing "abandoned"

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
    And the card no longer records a closing

  @server
  Scenario: Bots close cards and never delete them
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    Then the board tool has no delete action
    When the bot "Assistant" tries to delete the card through the board service
    Then the board service refuses it as forbidden
    And the card is still on the board

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
  Scenario: An owner deleting a card needs the revision the deleter saw
    Given the bot "Assistant" has a card titled "Pay the electric bill" at revision 3
    When an organization owner deletes the card expecting revision 2
    Then the deletion is a conflict
    And the card is still on the board
    When an organization owner deletes the card expecting revision 3
    Then the card is no longer on the board

  # ---------------------------------------------------------------- retries

  @server
  Scenario: A retried create does not make a second card
    Given the network answer to the next board write is lost
    And the bot "Assistant" creates a card titled "Pay the electric bill" with the operation id "op-1"
    When the bot "Assistant" repeats the same creation with the operation id "op-1"
    Then the board of "Assistant" has exactly one card titled "Pay the electric bill"
    And the repeated call returns the card the first call stored

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
  Scenario: A retried change resends the revision it first read even though the card has moved on
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    And the bot "Assistant" moved the card to the status "in_progress" by a tool call that read the revision first, with the operation id "op-3"
    And an organization owner changes the title of the card to "Pay the water bill" so that it is at revision 3
    When the worker retries that tool call
    Then the retry is answered as saved and wrote nothing
    And the card has the status "in_progress"
    And the card keeps the title "Pay the water bill"

  @server
  Scenario: A different revision under the same operation key is refused and reported as not saved
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    And the bot "Assistant" moved the card to the status "in_progress" with the operation id "op-2"
    When the bot "Assistant" uses operation id "op-2" to move the card to the status "in_progress" expecting revision 2
    Then the board tool reports that the operation id was used for a different change
    And the board tool reports that the change was not saved
    And the board tool says to use a new operation key
    And the card was written once

  @server
  Scenario: A turn that is retried by the worker does not repeat its board writes
    Given the bot "Assistant" runs a turn that creates the card "Pay the electric bill" and then the worker is interrupted
    When the worker retries the same tool call of that turn
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
    And no board tool result in the turn says the card was saved

  @server
  Scenario: A change whose answer was lost is checked before it is retried by hand
    Given the network answer to the next board write is lost
    And the bot "Assistant" uses the board tool to create a card titled "Pay the electric bill"
    When the bot "Assistant" uses the board tool to list its board
    Then the board tool lists "Pay the electric bill"

  @server
  Scenario: The board store being down does not stall the turn
    Given the board store is unreachable
    When the bot "Assistant" receives "add a card to your board titled Pay the electric bill"
    And the bot "Assistant" runs one computerless worker turn
    Then the turn finishes
    And the board tool reports that the card was not saved
    And the board of "Assistant" has no card titled "Pay the electric bill"

  @server
  Scenario: A card saved before the board's index has caught up is reported as pending
    Given the board's index has not caught up
    When the bot "Assistant" uses the board tool to create a card titled "Pay the electric bill"
    Then the board tool says the card is saved and that the listing may be behind
    And reading that card by its id returns the saved card

  # ---------------------------------------------------------------- the boundary

  @server
  Scenario: A bot cannot write to the board of another bot in the same organization
    Given the bot "Researcher" in the same organization has a card titled "Read the vendor report"
    When the bot "Assistant" uses the board tool to move the card of "Researcher" to the status "in_progress"
    Then the board tool reports that the card was not found
    And the card of "Researcher" is unchanged

  @server
  Scenario: A bot cannot choose a board by naming it
    Given the bot "Researcher" in the same organization has a card titled "Read the vendor report"
    When the bot "Assistant" uses the board tool and names the board of "Researcher"
    Then the board tool uses the board of "Assistant" and never the named one

  @server
  Scenario: A bot that is not in the organization has no board there
    Given the bot "Assistant" has a card titled "Pay the electric bill"
    And the bot "Outsider" belongs to the organization "Other House"
    When the bot "Outsider" uses the board tool to read the card of "Assistant"
    Then the board tool reports that the card was not found
    And no card content is returned

  @server
  Scenario: Bot board tools are available to a computerless worker turn
    Given the computer of "Anthus Labs" is stopped
    When the bot "Assistant" receives "add a card to your board titled Pay the electric bill"
    And the bot "Assistant" runs one computerless worker turn
    Then the card is on the board of "Assistant"
    And no computer continuation job is queued for the turn
    And no computer was summoned for the board tool
