Feature: Who can see and change a bot's board
  As an owner of an organization
  I want a bot's board to be visible to the people who can see the bot and changeable only by the right people
  So that a bot's work is transparent inside the organization, private from every other organization, and never reachable except through the front door

  DRAFT. Implemented by Milestone 2 (Kanbus epic chatticus-c5f14c) once the Kanbus-side dependencies in
  docs/BOT_BOARDS.md section 9 have landed. This file is not in features/cucumber-features.txt and no step in
  conversation/features-support/steps/ implements it yet. The contract is docs/BOT_BOARDS.md. Related drafts:
  bot_board_tool.feature (what the bot does), bot_board_task_migration.feature, web_bot_boards.feature. Tag: @server
  (the real front door routes with a fake Kanbus cloud store).

  A bot's board is reached only through the Chatticus front door. The front door resolves the signed-in member, checks
  the membership of the organization that owns the bot, decides read or write from the member's role, and only then asks
  the Kanbus cloud store, naming the organization and the bot itself and never taking either from the request. The
  computer holds no credential for the store and no route to it. Organization roles today are owner and member, and there
  is no admin role. Every member of the organization who can see a bot can see its board. Only the owners of the
  organization and the bot itself change it; every other member reads it and cannot change it. Bots close cards and never
  delete them; owners may delete cards. The front door calls the Kanbus store as a service principal and names the acting
  member or bot in the X-Kanbus-Actor header, which the store records as creator, comment author and event actor. A board
  the principal is not granted answers 403 without revealing that it exists; the front door answers a stranger as not
  found. When a bot is deleted its board is archived and later purged.

  Background:
    Given an empty control plane
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Anthus Labs" has the bot "Assistant" with a card titled "Pay the electric bill"
    And the organization "Other House" has the owner "olive@example.org" and a bot named "Assistant" with a card titled "Water the plants"

  # ---------------------------------------------------------------- who reads

  @server
  Scenario Outline: Every member who can see the bot reads its board
    When "<who>" lists the board of "Assistant" in "Anthus Labs"
    Then the response lists the card "Pay the electric bill"
    And the response names the board as the board of "Assistant"

    Examples:
      | who               |
      | ryan@example.com  |
      | ada@example.com   |
      | sam@example.com   |

  @server
  Scenario: A member reads one card with its comments
    Given the card "Pay the electric bill" has the comment "Waiting for the statement"
    When "sam@example.com" reads the card "Pay the electric bill" on the board of "Assistant"
    Then the response shows the title, the status, the priority and the comment "Waiting for the statement"


  # ---------------------------------------------------------------- who changes

  @server
  Scenario Outline: Owners change a bot's board
    When "<who>" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response is accepted
    And the card has the status "in_progress"
    And the card is updated by "<who>"

    Examples:
      | who               |
      | ryan@example.com  |
      | ada@example.com   |

  @server
  Scenario: An owner creates a card on a bot's board
    When "ryan@example.com" creates a card titled "Ask about the late fee" on the board of "Assistant"
    Then the card is on the board of "Assistant"
    And the card records "ryan@example.com" as its creator

  @server
  Scenario: An owner comments on a card
    When "ada@example.com" comments "Please use the card ending 42" on the card "Pay the electric bill" on the board of "Assistant"
    Then the card has the comment by "ada@example.com"

  @server
  Scenario: A change is made on behalf of the person or bot who made it
    When "ryan@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the board store was called by the Chatticus service principal
    And the board store was told the actor is "chatticus:user:" followed by the identifier of "ryan@example.com"
    When the bot "Assistant" of "Anthus Labs" comments "Started" on the card "Pay the electric bill"
    Then the board store was told the actor is "chatticus:bot:" followed by the identifier of "Assistant"

  @server
  Scenario: Owners may delete a card and a bot may not
    When the bot "Assistant" of "Anthus Labs" tries to delete the card "Pay the electric bill"
    Then the response is forbidden
    And the card is still on the board of "Assistant"
    When "sam@example.com" tries to delete the card "Pay the electric bill" on the board of "Assistant"
    Then the response is forbidden
    When "ryan@example.com" deletes the card "Pay the electric bill" on the board of "Assistant"
    Then the card is no longer on the board of "Assistant"

  @server
  Scenario: A member who is not an owner reads and cannot change
    When "sam@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response is forbidden
    And the card has the status "open"
    When "sam@example.com" creates a card titled "Sneaky" on the board of "Assistant"
    Then the response is forbidden
    And the board of "Assistant" has no card titled "Sneaky"
    When "sam@example.com" comments "hello" on the card "Pay the electric bill" on the board of "Assistant"
    Then the response is forbidden
    And the card has no comments

  @server
  Scenario: An owner completes and closes a card under the same rules as the bot
    When "ryan@example.com" tries to complete the card "Pay the electric bill" without evidence
    Then completing the card is refused for missing evidence
    When "ryan@example.com" closes the card "Pay the electric bill" with the reason "paid by another route"
    Then the card has the status "closed"
    And the card has a closing comment with the reason "paid by another route"
    And the card records the closing "abandoned"

  @server
  Scenario: The bot changes its own board and no one else's
    When the bot "Assistant" of "Anthus Labs" moves the card "Pay the electric bill" to the status "in_progress"
    Then the response is accepted
    And the card is updated by "Assistant"
    When the bot "Assistant" of "Anthus Labs" moves a card of the bot "Researcher" to the status "in_progress"
    Then the response is forbidden


  # ---------------------------------------------------------------- strangers

  @server
  Scenario: A member of another organization sees nothing
    When "olive@example.org" lists the board of "Assistant" in "Anthus Labs"
    Then the response is not found
    And no card content is returned

  @server
  Scenario: A guessed card identifier discloses nothing and changes nothing
    When "olive@example.org" reads the card "Pay the electric bill" on the board of "Assistant" in "Anthus Labs" using its real identifier
    Then the response is not found
    When "olive@example.org" moves that card to the status "closed" using its real identifier
    Then the response is not found
    And the card in "Anthus Labs" is unchanged

  @server
  Scenario: Two organizations with a bot of the same name have two separate boards
    When "ryan@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response lists the card "Pay the electric bill"
    And the response does not list the card "Water the plants"
    When "olive@example.org" lists the board of "Assistant" in "Other House"
    Then the response lists the card "Water the plants"
    And the response does not list the card "Pay the electric bill"

  @server
  Scenario: The organization and the bot in the request body are ignored
    When "ryan@example.com" creates a card titled "Ask about the late fee" on the board of "Assistant" in "Anthus Labs" naming "Other House" in the request body
    Then the card is on the board of "Assistant" in "Anthus Labs"
    And the board of "Assistant" in "Other House" has no card titled "Ask about the late fee"

  @server
  Scenario: A request without a signed-in member is refused
    When an unauthenticated caller lists the board of "Assistant" in "Anthus Labs"
    Then the response is unauthorized
    And no card content is returned


  # ---------------------------------------------------------------- revocation and change of role

  @server
  Scenario: A member who is removed stops reading at the next request
    Given "sam@example.com" has read the board of "Assistant"
    When "ryan@example.com" removes "sam@example.com" from "Anthus Labs"
    And "sam@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response is not found




  @server
  Scenario: An owner who is demoted to a member stops changing at the next request
    When "ryan@example.com" changes the role of "ada@example.com" to member
    And "ada@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response is forbidden
    When "ada@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response lists the card "Pay the electric bill"

  @server
  Scenario: A member who is promoted to owner changes cards at the next request
    When "ryan@example.com" changes the role of "sam@example.com" to owner
    And "sam@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response is accepted

  # ---------------------------------------------------------------- archive when a bot is deleted

  @server
  Scenario: The board of a deleted bot is archived and cannot be read or written
    When "ryan@example.com" deletes the bot "Assistant"
    Then the board of "Assistant" is archived
    When "ryan@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response is not found
    When "ryan@example.com" creates a card titled "Late" on the board of "Assistant"
    Then the response is not found

  @server
  Scenario: An owner restores an archived board and a member cannot
    Given the bot "Assistant" was deleted and its board is archived
    When "sam@example.com" restores the board of "Assistant"
    Then the response is forbidden
    When "ryan@example.com" restores the board of "Assistant"
    Then the board of "Assistant" lists the card "Pay the electric bill" again

  @server
  Scenario: An archived board is purged after thirty days
    Given the bot "Assistant" was deleted and its board is archived
    When 31 days pass
    Then the board of "Assistant" is purged
    And restoring the board of "Assistant" is refused because it is gone

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
    Then the board of "Assistant" is purged

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
  Scenario: Every denied board request is recorded
    When "sam@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    And "olive@example.org" lists the board of "Assistant" in "Anthus Labs"
    Then the audit log has a record for "sam@example.com" with the outcome "refused" for the board of "Assistant"
    And the audit log has a record for "olive@example.org" with the outcome "refused" for the board of "Assistant"
    And no audit record contains card text
