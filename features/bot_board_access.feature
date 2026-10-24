Feature: Who can see and change a bot's board
  As an owner of an organization
  I want a bot's board to be visible to the people who can see the bot and changeable only by the right people
  So that a bot's work is transparent inside the organization, private from every other organization, and never reachable except through the front door

  DRAFT. What remains here is not built yet. The scenarios that the front door routes implement moved to
  bot_board_routes.feature, which is registered in features/cucumber-features.txt: who reads, who changes, closing,
  deleting, strangers, role changes, archive and restore by an owner, the audit of denied requests, and the deployment
  without a board service. The bot's own side of the access rules (the actor chatticus:bot:<id>, a bot never deleting, a
  bot reaching only its own board) is specified by bot_board_tool.feature and bot_board_owner_actions.feature. What stays
  draft, and why:
  - Member removal: the membership store has no removal yet.
  - Bot deletion and the purge of an archived board: the product has no bot deletion route, and Chatticus calls no purge.
  - The computer holds no credential for the store and its file routes cannot reach board records: structural checks
    that need a later phase.
  - Creating a card with a chosen identifier and a listing that reports catalog_pending: the published
    @kanbus/api-client 0.1.1 has no id field on create and a listing page carries no pending flag.
  The contract is docs/BOT_BOARDS.md. Tag: @server (the real front door routes with a fake Kanbus cloud store).

  Background:
    Given an empty control plane
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Anthus Labs" has the bot "Assistant" with a card titled "Pay the electric bill"
    And the organization "Other House" has the owner "olive@example.org" and a bot named "Assistant" with a card titled "Water the plants"

  # ---------------------------------------------------------------- who reads

  @server
  Scenario: A member who is removed stops reading at the next request
    Given "sam@example.com" has read the board of "Assistant"
    When "ryan@example.com" removes "sam@example.com" from "Anthus Labs"
    And "sam@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response is not found

  @server
  Scenario: The board of a deleted bot is archived and cannot be read or written
    When "ryan@example.com" deletes the bot "Assistant"
    Then the board of "Assistant" is archived with a purge date 30 days later
    And the board store refuses every write to it as archived
    When "ryan@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response is not found
    When "ryan@example.com" creates a card titled "Late" on the board of "Assistant"
    Then the response is not found

  @server
  Scenario: An archived board is purged by Kanbus after thirty days and Chatticus does not purge it
    Given the bot "Assistant" was deleted and its board is archived
    When 31 days pass and the Kanbus sweeper runs
    Then the board of "Assistant" is purged
    And Chatticus made no purge call
    And restoring the board of "Assistant" is refused because it is gone or already purged

  @server
  Scenario: An archived board is not purged before thirty days
    Given the bot "Assistant" was deleted and its board is archived
    When 29 days pass
    Then the board of "Assistant" is still archived and restorable

  @server
  Scenario: An owner may ask for immediate removal of an archived board
    Given the bot "Assistant" was deleted and its board is archived
    When "sam@example.com" asks for the immediate removal of the board of "Assistant"
    Then the response is forbidden
    And the board of "Assistant" is still archived and restorable
    When "ryan@example.com" asks for the immediate removal of the board of "Assistant"
    Then the board of "Assistant" is archived and then purged
    And a bot deletion alone never purges a board

  # ---------------------------------------------------------------- the front door is the only way

  @server
  Scenario: The computer holds no way to reach the board store
    Given the organization computer of "Anthus Labs" is running
    Then the credentials issued to the computer owner and to its turns grant no access to the board store
    And the credentials issued to the computer owner and to its turns name no board service address
    And a request from the computer to the board store is refused

  @server
  Scenario: A computer file route cannot be used to read board records
    When "ryan@example.com" asks the computer file routes for the stored records of the board of "Assistant"
    Then the file routes find nothing
    And the file routes never contact the board store

  @server
  Scenario: Creating a card is conditional on the card not being there already
    Given the bot "Assistant" has created a card with a chosen identifier
    When another request creates a card with the same identifier
    Then the second creation is a conflict
    And the first card is unchanged

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
