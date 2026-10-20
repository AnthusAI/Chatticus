Feature: Only the bot itself and the owners of the organization change a bot's board
  As an owner of an organization
  I want the board service to apply the Chatticus access rules before it asks the Kanbus board service
  So that a bot's work is readable by every member who can see the bot, changeable only by its owners and the bot itself, and never reachable by a stranger

  These scenarios are about the board service module (conversation/src/board), the part of the front door that a later phase
  puts behind HTTP routes (bot_board_access.feature). The module reads the caller's role at every call, so a removal or a
  change of role takes effect at the next call. Reads are for every member of the organization. Changes are for the owners
  and, on its own board only, for the bot; only an owner deletes a card, and a bot never does. A stranger gets not found and
  a member without write gets forbidden. Every change is made as a service principal that names the acting person or bot,
  and the board service records that name. Board lifecycle (archive and restore) needs an owner and the front door's
  provisioning role.

  Background:
    Given an empty control plane
    And the Kanbus board service is configured for this environment
    And the organization "Anthus Labs" has the owners "ryan" and "ada" and the member "sam"
    And the organization "Other House" has the owner "olive"
    And the organization "Anthus Labs" has the bot "Assistant" with a card titled "Pay the electric bill"

  @server
  Scenario Outline: Every member who can see the bot reads its board
    When "<who>" lists the board of "Assistant" in "Anthus Labs" through the board service
    Then the board service lists the card "Pay the electric bill"

    Examples:
      | who  |
      | ryan |
      | ada  |
      | sam  |

  @server
  Scenario Outline: Owners change a bot's board and the change is made in their name
    When "<who>" moves the card "Pay the electric bill" to the status "in_progress" through the board service
    Then the board service accepts the change
    And the card has the status "in_progress"
    And the store recorded the actor "chatticus:user:" followed by the identifier of "<who>"

    Examples:
      | who  |
      | ryan |
      | ada  |

  @server
  Scenario: An owner creates a card and comments on a card
    When "ryan" creates a card titled "Ask about the late fee" on the board of "Assistant" through the board service
    Then the card "Ask about the late fee" records the actor of "ryan" as its creator
    When "ada" comments "Please use the card ending 42" on the card "Pay the electric bill" through the board service
    Then the card "Pay the electric bill" has a comment by the actor of "ada" with the text "Please use the card ending 42"

  @server
  Scenario: A member who is not an owner reads and cannot change
    When "sam" moves the card "Pay the electric bill" to the status "in_progress" through the board service
    Then the board service refuses it as forbidden
    And the card "Pay the electric bill" has the status "open"
    When "sam" creates a card titled "Sneaky" on the board of "Assistant" through the board service
    Then the board service refuses it as forbidden
    And the board of "Assistant" has no card titled "Sneaky"
    When "sam" comments "hello" on the card "Pay the electric bill" through the board service
    Then the board service refuses it as forbidden
    And the card "Pay the electric bill" has no comments

  @server
  Scenario: Owners delete a card under the revision they saw, and members and bots do not
    When "sam" tries to delete the card "Pay the electric bill" through the board service
    Then the board service refuses it as forbidden
    When the bot "Assistant" tries to delete the card "Pay the electric bill" through the board service
    Then the board service refuses it as forbidden
    And the card "Pay the electric bill" is still on the board of "Assistant"
    When "ryan" deletes the card "Pay the electric bill" expecting a stale revision through the board service
    Then the board service reports a conflict
    And the card "Pay the electric bill" is still on the board of "Assistant"
    When "ryan" deletes the card "Pay the electric bill" through the board service
    Then the card "Pay the electric bill" is no longer on the board of "Assistant"

  @server
  Scenario: An owner completes and closes a card under the same rules as the bot
    When "ryan" tries to complete the card "Pay the electric bill" without evidence through the board service
    Then the board service refuses it for missing evidence
    When "ryan" closes the card "Pay the electric bill" with the reason "paid by another route" through the board service
    Then the card "Pay the electric bill" has the status "closed"
    And the card "Pay the electric bill" has a closing comment holding the text "paid by another route"
    And the card "Pay the electric bill" records the closing "abandoned"

  @server
  Scenario: The bot changes its own board and no one else's
    Given the organization "Anthus Labs" has the bot "Researcher" with a card titled "Read the vendor report"
    When the bot "Assistant" moves the card "Pay the electric bill" to the status "in_progress" through the board service
    Then the board service accepts the change
    And the store recorded the actor "chatticus:bot:" followed by the identifier of "Assistant"
    When the bot "Assistant" moves the card "Read the vendor report" of the bot "Researcher" to the status "in_progress" through the board service
    Then the board service refuses it as forbidden
    And the card "Read the vendor report" has the status "open"

  @server
  Scenario: A member of another organization sees nothing
    When "olive" lists the board of "Assistant" in "Anthus Labs" through the board service
    Then the board service reports that the board was not found
    When "olive" moves the card "Pay the electric bill" to the status "closed" through the board service
    Then the board service reports that the board was not found
    And the card "Pay the electric bill" has the status "open"

  @server
  Scenario: A change of role takes effect at the next call
    When "ryan" changes the role of "ada" to member
    And "ada" moves the card "Pay the electric bill" to the status "in_progress" through the board service
    Then the board service refuses it as forbidden
    When "ada" lists the board of "Assistant" in "Anthus Labs" through the board service
    Then the board service lists the card "Pay the electric bill"
    When "ryan" changes the role of "sam" to owner
    And "sam" moves the card "Pay the electric bill" to the status "in_progress" through the board service
    Then the board service accepts the change

  @server
  Scenario: The board of a deleted bot is archived, hidden from the bot and restorable by an owner
    When "sam" archives the board of "Assistant" through the board service
    Then the board service refuses it as forbidden
    When "ryan" archives the board of "Assistant" through the board service
    Then the board service accepts the change
    And the board of "Assistant" is archived with a purge date 30 days later
    When the bot "Assistant" uses the board service to list its board
    Then the board service reports that the board was not found
    When "ryan" creates a card titled "Late" on the board of "Assistant" through the board service
    Then the board service reports that the board is archived
    When "sam" restores the board of "Assistant" through the board service
    Then the board service refuses it as forbidden
    When "ryan" restores the board of "Assistant" through the board service
    Then the board service accepts the change
    And the board service lists the card "Pay the electric bill" for the bot "Assistant"
    When "ryan" restores the board of "Assistant" through the board service
    Then the board service refuses the restore because the board is not archived

  @server
  Scenario: Chatticus never purges an archived board
    Given "ryan" archived the board of "Assistant"
    When 31 days pass and the Kanbus sweeper runs
    Then the board of "Assistant" is purged by Kanbus
    And Chatticus made no purge call
