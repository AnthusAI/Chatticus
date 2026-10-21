Feature: A bot's board over the front door
  As a member of an organization
  I want to read my bots' boards, and as an owner to change them, through the front door
  So that a bot's work is visible to the people who can see the bot, changeable only by its owners, and private from every other organization

  These scenarios are the HTTP routes of a bot's board. They sit in front of the board service module
  (bot_board_owner_actions.feature), which applies the Chatticus rules and calls the Kanbus board service
  (docs/BOT_BOARDS.md sections 5 and 6). The board is in the path, under the bot:

    GET    /orgs/{organization}/bots/{bot}/board                                    overview: configuration and the first cards
    GET    /orgs/{organization}/bots/{bot}/board/cards                              list cards
    GET    /orgs/{organization}/bots/{bot}/board/cards/{card}                       one card with its comments
    POST   /orgs/{organization}/bots/{bot}/board/cards                              create a card
    PATCH  /orgs/{organization}/bots/{bot}/board/cards/{card}                       title, description, priority, labels, status
    POST   /orgs/{organization}/bots/{bot}/board/cards/{card}/comments              comment
    POST   /orgs/{organization}/bots/{bot}/board/cards/{card}/complete              complete, with evidence
    POST   /orgs/{organization}/bots/{bot}/board/cards/{card}/abandon               close, with a reason
    POST   /orgs/{organization}/bots/{bot}/board/cards/{card}/reopen                reopen
    PUT    /orgs/{organization}/bots/{bot}/board/cards/{card}/parent                set or clear the parent
    POST   /orgs/{organization}/bots/{bot}/board/cards/{card}/dependencies          add a dependency
    DELETE /orgs/{organization}/bots/{bot}/board/cards/{card}/dependencies/{target} remove a dependency
    DELETE /orgs/{organization}/bots/{bot}/board/cards/{card}                       delete a card (owner)
    POST   /orgs/{organization}/bots/{bot}/board/archive                            archive the board (owner)
    POST   /orgs/{organization}/bots/{bot}/board/restore                            restore the board (owner)

  Every member of the organization reads. Only owners change or delete. The organization and the bot come from the
  path and never from the request body. A change names the revision the person saw in If-Match, and the optional
  Idempotency-Key makes a retried request replay instead of repeating. The front door sends the Kanbus card JSON
  through; it does not reshape it. A stranger, an unknown bot and a bot of another organization all look the same: not
  found, with no card content. Where the deployment has no board service the routes answer 404 board_service_not_enabled.
  Scenarios that need member removal (the membership store has none), bot deletion, the bot's own tool path or the
  purge of a board stay in bot_board_access.feature as drafts. An archived board is hidden from non-owners: they get not
  found for every read and write, owners still read and restore it, and a write on it is refused as archived.

  Background:
    Given an empty control plane
    And the Kanbus board service is configured for this environment
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Other House" has the owner "olive@example.org"
    And the organization "Anthus Labs" has a bot named "Assistant" with a card titled "Pay the electric bill"
    And the organization "Other House" has a bot named "Assistant" with a card titled "Water the plants"

  # ---------------------------------------------------------------- who reads

  Scenario: A member opens the overview of a bot's board
    When "sam@example.com" opens the board of "Assistant" in "Anthus Labs"
    Then the response is ok
    And the response carries the Kanbus default configuration of the board
    And the response lists the card "Pay the electric bill"
    And the response names the board as the board of "Assistant"

  Scenario Outline: Every member who can see the bot reads its board
    When "<who>" lists the board of "Assistant" in "Anthus Labs"
    Then the response is ok
    And the response lists the card "Pay the electric bill"

    Examples:
      | who               |
      | ryan@example.com  |
      | ada@example.com   |
      | sam@example.com   |

  Scenario: A listing can be limited to a page and to a status
    Given the card "Pay the electric bill" is moved to the status "in_progress" by the bot
    And the bot "Assistant" has a card titled "Ask about the late fee"
    When "sam@example.com" lists the board of "Assistant" in "Anthus Labs" with the status "in_progress"
    Then the response lists the card "Pay the electric bill"
    And the response does not list the card "Ask about the late fee"
    When "sam@example.com" lists the board of "Assistant" in "Anthus Labs" with a limit of 1
    Then the response lists exactly 1 card

  Scenario: A member reads one card with its comments
    Given the card "Pay the electric bill" has the comment "Waiting for the statement" from the bot
    When "sam@example.com" reads the card "Pay the electric bill" on the board of "Assistant"
    Then the response is ok
    And the response shows the title, the status, the priority and the comment "Waiting for the statement"
    And the response carries the revision of the card

  # ---------------------------------------------------------------- who changes

  Scenario Outline: Owners change a bot's board
    When "<who>" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response is ok
    And the card has the status "in_progress"

    Examples:
      | who               |
      | ryan@example.com  |
      | ada@example.com   |

  Scenario: An owner creates a card on a bot's board
    When "ryan@example.com" creates a card titled "Ask about the late fee" on the board of "Assistant"
    Then the response is ok
    And the card "Ask about the late fee" is on the board of "Assistant"
    And the card "Ask about the late fee" records "ryan@example.com" as its creator

  Scenario: An owner comments on a card
    When "ada@example.com" comments "Please use the card ending 42" on the card "Pay the electric bill" on the board of "Assistant"
    Then the response is ok
    And the card has the comment "Please use the card ending 42" by "ada@example.com"

  Scenario: An owner edits the title, the priority and the labels of a card
    When "ryan@example.com" edits the card "Pay the electric bill" on the board of "Assistant" setting the title "Pay the water bill" and the priority 1 and the label "money"
    Then the response is ok
    And the card is now titled "Pay the water bill" with the priority 1 and the label "money"

  Scenario: A change is made on behalf of the person who made it
    When "ryan@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the board store was called by the Chatticus service principal
    And the board store was told the actor is "chatticus:user:" followed by the identifier of "ryan@example.com"

  Scenario: An owner puts a card under a parent and takes it out again
    Given the bot "Assistant" has an epic titled "Household money"
    When "ryan@example.com" puts the card "Pay the electric bill" under the card "Household money" on the board of "Assistant"
    Then the response is ok
    And the card "Pay the electric bill" is under the card "Household money"
    When "ryan@example.com" takes the card "Pay the electric bill" out from under its parent on the board of "Assistant"
    Then the response is ok
    And the card "Pay the electric bill" has no parent

  Scenario: An owner adds and removes a dependency
    Given the bot "Assistant" has a card titled "Ask about the late fee"
    When "ryan@example.com" records that the card "Pay the electric bill" is blocked by the card "Ask about the late fee" on the board of "Assistant"
    Then the response is ok
    And the card "Pay the electric bill" is blocked by the card "Ask about the late fee"
    When "ryan@example.com" removes the dependency of the card "Pay the electric bill" on the card "Ask about the late fee" on the board of "Assistant"
    Then the response is ok
    And the card "Pay the electric bill" depends on no card

  Scenario Outline: A member who is not an owner cannot use any write route
    Given the bot "Assistant" has an epic titled "Household money"
    And the bot "Assistant" has a card titled "Ask about the late fee"
    And the bot "Assistant" recorded that the card "Pay the electric bill" is blocked by the card "Ask about the late fee"
    When "sam@example.com" calls the route "<route>" on the board of "Assistant"
    Then the response is forbidden
    And nothing changed on the board of "Assistant"

    Examples:
      | route             |
      | create            |
      | update            |
      | comment           |
      | complete          |
      | abandon           |
      | reopen            |
      | parent            |
      | add dependency    |
      | remove dependency |
      | delete            |
      | archive           |
      | restore           |

  Scenario: A card cannot be created already closed
    When "ryan@example.com" creates a card titled "Closed on arrival" on the board of "Assistant" with the status "closed"
    Then the response is refused as needing evidence or a reason
    And the board of "Assistant" in "Anthus Labs" has no card titled "Closed on arrival"
    When "ryan@example.com" creates a card titled "Started at once" on the board of "Assistant" with the status "in_progress"
    Then the response is ok

  # ---------------------------------------------------------------- closing

  Scenario: An owner completes a card only with evidence
    When "ryan@example.com" tries to complete the card "Pay the electric bill" without evidence
    Then the response is refused as missing evidence
    And the card has the status "open"
    When "ryan@example.com" completes the card "Pay the electric bill" with the evidence "Confirmation number 4471"
    Then the response is ok
    And the card has the status "closed"
    And the card has a closing comment holding "Confirmation number 4471"
    And the card records the closing "completed"

  Scenario: An owner abandons a card only with a reason
    When "ryan@example.com" tries to abandon the card "Pay the electric bill" without a reason
    Then the response is refused as missing a reason
    When "ryan@example.com" abandons the card "Pay the electric bill" with the reason "paid by another route"
    Then the response is ok
    And the card has the status "closed"
    And the card has a closing comment holding "paid by another route"
    And the card records the closing "abandoned"

  Scenario: A plain move to closed is refused
    When "ryan@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "closed"
    Then the response is refused as needing evidence or a reason
    And the card has the status "open"

  Scenario: An owner reopens a closed card
    Given the bot "Assistant" has a closed card titled "Pay the electric bill again"
    When "ryan@example.com" reopens the card "Pay the electric bill again" on the board of "Assistant"
    Then the response is ok
    And the card has the status "open"
    And the card has no closing time

  Scenario: A closed card changes status only by being reopened
    Given the bot "Assistant" has a closed card titled "Pay the electric bill again"
    When "ryan@example.com" moves the card "Pay the electric bill again" on the board of "Assistant" to the status "in_progress"
    Then the response is refused because a closed card is only reopened
    And the card has the status "closed"
    When "ryan@example.com" moves the card "Pay the electric bill again" on the board of "Assistant" to the status "closed"
    Then the response is refused as needing evidence or a reason

  # ---------------------------------------------------------------- deleting

  Scenario: Only owners delete a card
    When "sam@example.com" deletes the card "Pay the electric bill" on the board of "Assistant"
    Then the response is forbidden
    And the card "Pay the electric bill" is on the board of "Assistant"
    When "ryan@example.com" deletes the card "Pay the electric bill" on the board of "Assistant"
    Then the response is ok
    And the card "Pay the electric bill" is no longer on the board of "Assistant"

  # ---------------------------------------------------------------- honesty about saving

  Scenario: A change made without the revision the person saw is refused
    When "ryan@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress" without a revision
    Then the response asks for the revision
    And the card has the status "open"

  Scenario: A change made against a stale revision is a conflict that names the current revision
    Given the card "Pay the electric bill" has the comment "Waiting for the statement" from the bot
    When "ryan@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress" using the revision the card had before
    Then the response is a conflict
    And the response carries the current revision and the current card
    And the card has the status "open"
    When "ryan@example.com" repeats the move using the current revision from the response
    Then the response is ok
    And the card has the status "in_progress"

  Scenario: A change the store cannot confirm is reported as not saved
    Given the board store cannot confirm writes
    When "ryan@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response says the change was not confirmed and may or may not be stored

  Scenario: A saved card that the listing does not show yet is flagged as pending
    Given the board's index has not caught up
    When "ryan@example.com" creates a card titled "Ask about the late fee" on the board of "Assistant"
    Then the response is ok
    And the response flags the listing as possibly behind
    When "ryan@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response does not list the card "Ask about the late fee"
    When "ryan@example.com" reads the card "Ask about the late fee" on the board of "Assistant"
    Then the response is ok

  Scenario: A retried request with the same Idempotency-Key does not repeat the change
    When "ryan@example.com" creates a card titled "Ask about the late fee" on the board of "Assistant" with the Idempotency-Key "retry-1"
    And "ryan@example.com" creates a card titled "Ask about the late fee" on the board of "Assistant" with the Idempotency-Key "retry-1"
    Then the board of "Assistant" in "Anthus Labs" has exactly 1 card titled "Ask about the late fee"

  # ---------------------------------------------------------------- strangers

  Scenario: A member of another organization sees nothing
    When "olive@example.org" lists the board of "Assistant" in "Anthus Labs"
    Then the response is not found
    And the response carries no card content
    And the board store was not called

  Scenario: A guessed card identifier discloses nothing and changes nothing
    When "olive@example.org" reads the card "Pay the electric bill" on the board of "Assistant" in "Anthus Labs" using its real identifier
    Then the response is not found
    When "olive@example.org" moves that card to the status "closed" using its real identifier
    Then the response is not found
    And the card in "Anthus Labs" is unchanged

  Scenario: A bot of another organization and an unknown bot look the same as a stranger
    When "olive@example.org" opens the board of the "Anthus Labs" bot "Assistant" under the organization "Other House"
    Then the response is not found
    When "ryan@example.com" opens the board of an unknown bot in "Anthus Labs"
    Then the response is not found
    And the board store was not called

  Scenario: Two organizations with a bot of the same name have two separate boards
    When "ryan@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response lists the card "Pay the electric bill"
    And the response does not list the card "Water the plants"
    When "olive@example.org" lists the board of "Assistant" in "Other House"
    Then the response lists the card "Water the plants"
    And the response does not list the card "Pay the electric bill"

  Scenario: The organization and the bot in the request body are ignored
    When "ryan@example.com" creates a card titled "Ask about the late fee" on the board of "Assistant" in "Anthus Labs" naming "Other House" in the request body
    Then the response is ok
    And the card "Ask about the late fee" is on the board of "Assistant"
    And the board of "Assistant" in "Other House" has no card titled "Ask about the late fee"

  Scenario: A request without a signed-in member is refused
    When an unauthenticated caller lists the board of "Assistant" in "Anthus Labs"
    Then the response is refused as not signed in
    And the response carries no card content
    And the board store was not called

  # ---------------------------------------------------------------- role changes take effect at the next request

  Scenario: An owner who is demoted to a member stops changing at the next request
    When "ryan@example.com" changes the role of "ada@example.com" in "Anthus Labs" to member
    And "ada@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response is forbidden
    When "ada@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response lists the card "Pay the electric bill"

  Scenario: A member who is promoted to owner changes cards at the next request
    When "ryan@example.com" changes the role of "sam@example.com" in "Anthus Labs" to owner
    And "sam@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response is ok

  Scenario: A member whose membership is gone is not found at the next request even while the sign-in cache is warm
    When "sam@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response lists the card "Pay the electric bill"
    When the membership of "sam@example.com" in "Anthus Labs" is deleted from the store
    And "sam@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response is not found
    When "ada@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response is ok
    When the membership of "ada@example.com" in "Anthus Labs" is deleted from the store
    And "ada@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "blocked"
    Then the response is not found

  # ---------------------------------------------------------------- archive and restore

  Scenario: An owner archives a bot's board and restores it, and a member cannot
    When "sam@example.com" archives the board of "Assistant" in "Anthus Labs"
    Then the response is forbidden
    When "ryan@example.com" archives the board of "Assistant" in "Anthus Labs"
    Then the response is ok
    And the board of "Assistant" is archived with a purge date 30 days later
    When "ryan@example.com" creates a card titled "Late" on the board of "Assistant"
    Then the response says the board is archived
    When "sam@example.com" restores the board of "Assistant" in "Anthus Labs"
    Then the response is not found
    When "ryan@example.com" restores the board of "Assistant" in "Anthus Labs"
    Then the response is ok
    And the card "Pay the electric bill" is on the board of "Assistant"
    When "ryan@example.com" restores the board of "Assistant" in "Anthus Labs"
    Then the response refuses the restore because the board is not archived

  Scenario: A member cannot see an archived board
    Given "ryan@example.com" has archived the board of "Assistant" in "Anthus Labs"
    When "sam@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response is not found
    And the response carries no card content
    When "sam@example.com" opens the board of "Assistant" in "Anthus Labs"
    Then the response is not found
    When "sam@example.com" reads the card "Pay the electric bill" on the board of "Assistant"
    Then the response is not found
    When "sam@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response is not found

  Scenario: An owner still reads an archived board and restores it, and members read it again
    Given "ryan@example.com" has archived the board of "Assistant" in "Anthus Labs"
    When "ryan@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response lists the card "Pay the electric bill"
    When "ryan@example.com" restores the board of "Assistant" in "Anthus Labs"
    Then the response is ok
    When "sam@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response lists the card "Pay the electric bill"

  Scenario: A write on an archived board is refused as archived for an owner
    Given "ryan@example.com" has archived the board of "Assistant" in "Anthus Labs"
    When "ryan@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response says the board is archived

  Scenario: Chatticus never purges a board through the routes
    When "ryan@example.com" archives the board of "Assistant" in "Anthus Labs"
    Then the response is ok
    And Chatticus made no purge call

  Scenario: A card of another bot's board used on this bot's routes is not found and changes nothing
    Given the organization "Anthus Labs" has a bot named "Researcher" with a card titled "Read the vendor report"
    When "ryan@example.com" reads the card "Read the vendor report" of the bot "Researcher" on the board of "Assistant"
    Then the response is not found
    When "ryan@example.com" moves the card "Read the vendor report" of the bot "Researcher" on the board of "Assistant" to the status "in_progress"
    Then the response is not found
    And the card of the bot "Researcher" is unchanged

  Scenario Outline: A path identifier that is not an identifier is not found before anything is called
    When "ryan@example.com" requests the card path "<identifier>" on the board of "Assistant"
    Then the response is not found
    And the board store was not called
    When "ryan@example.com" requests the removal of the dependency "<identifier>" of a card on the board of "Assistant"
    Then the response is not found
    And the board store was not called

    Examples:
      | identifier  |
      | %2e%2e      |
      | a%2Fb       |
      | 129 letters |

  Scenario Outline: A bot identifier that is not an identifier is not found before anything is called
    When "ryan@example.com" requests the board of the bot "<identifier>" in "Anthus Labs"
    Then the response is not found
    And the board store was not called

    Examples:
      | identifier  |
      | a%2Fb       |
      | 129 letters |

  # ---------------------------------------------------------------- limits

  Scenario Outline: A field that is too long is refused before it reaches the board
    When "ryan@example.com" sends the "<write>" write with the field "<field>" of <length> characters
    Then the response is refused as too long
    And the board store received no change

    Examples:
      | write    | field       | length |
      | create   | title       | 301    |
      | update   | title       | 301    |
      | create   | description | 20001  |
      | update   | description | 20001  |
      | create   | label       | 65     |
      | update   | labels      | 21     |
      | comment  | text        | 10001  |
      | complete | evidence    | 10001  |
      | abandon  | reason      | 10001  |

  Scenario: A request body that is too large is refused
    When "ryan@example.com" sends the "create" write with the field "padding" of 70000 characters
    Then the response is refused as too large
    And the board store received no change

  Scenario Outline: A field at the limit is accepted
    When "ryan@example.com" sends the "<write>" write with the field "<field>" of <length> characters
    Then the response is ok

    Examples:
      | write   | field | length |
      | create  | title | 300    |
      | comment | text  | 10000  |

  # ---------------------------------------------------------------- one owner's retry key is not another's

  Scenario: Two owners using the same Idempotency-Key for the same action do not collide
    When "ryan@example.com" comments "First owner" on the card "Pay the electric bill" on the board of "Assistant" with the Idempotency-Key "shared-1"
    Then the response is ok
    When "ada@example.com" comments "Second owner" on the card "Pay the electric bill" on the board of "Assistant" with the Idempotency-Key "shared-1"
    Then the response is ok
    And the card has the comment "First owner" by "ryan@example.com"
    And the card has the comment "Second owner" by "ada@example.com"

  # ---------------------------------------------------------------- a service failure tells the client nothing about the service

  @owner-log
  Scenario: A gateway failure is reported with a constant message and logged in full
    Given the board gateway answers every request with HTTP 500 and the body "internal gateway detail zx81"
    When "ryan@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response says the board service did not confirm the request
    And the board response does not contain "zx81"
    And the error log holds "zx81"

  @owner-log
  Scenario: An unreachable board service is reported with a constant message
    Given the board store is unreachable
    When "ryan@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    Then the response says the board service did not confirm the request
    And the board response does not contain "fetch failed"
    And the error log holds "fetch failed"

  # ---------------------------------------------------------------- the front door is the only way

  Scenario: The computer is never involved
    Given the computer of "Anthus Labs" is stopped
    When "sam@example.com" lists the board of "Assistant" in "Anthus Labs"
    Then the response lists the card "Pay the electric bill"
    And the computer of "Anthus Labs" is still stopped

  Scenario: Every denied board request is recorded without card text
    When "sam@example.com" moves the card "Pay the electric bill" on the board of "Assistant" to the status "in_progress"
    And "olive@example.org" lists the board of "Assistant" in "Anthus Labs"
    Then the audit log has a record for "sam@example.com" with the outcome "refused" for the board of "Assistant"
    And the audit log has a record for "olive@example.org" with the outcome "refused" for the board of "Assistant"
    And no audit record contains card text

  # ---------------------------------------------------------------- a deployment without the capability

  Scenario Outline: Where the deployment has no board service every route says so
    Given the bot "Assistant" has an epic titled "Household money"
    And the bot "Assistant" has a card titled "Ask about the late fee"
    And the deployment has no board service
    When "ryan@example.com" calls the route "<route>" on the board of "Assistant"
    Then the response is not found with the code "board_service_not_enabled"
    And the board store was not called

    Examples:
      | route             |
      | overview          |
      | list              |
      | get               |
      | create            |
      | update            |
      | comment           |
      | complete          |
      | abandon           |
      | reopen            |
      | parent            |
      | add dependency    |
      | remove dependency |
      | delete            |
      | archive           |
      | restore           |
