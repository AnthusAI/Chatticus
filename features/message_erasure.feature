Feature: Deleting a message erases its text, and the bot no longer sees it
  As a member of an organization
  I want a deleted message to be gone, not hidden
  So that no privacy or retention problem is waiting in a store I forgot about

  Deleting turns the message into a tombstone in the channel record, deletes it from
  every mailbox, and drops and rebuilds the Pi session of each bot on the channel from the
  record, so the session holds every other message and none of the erased text. Stores
  that expire on their own are named in docs/MESSAGE_ERASURE.md and are not claimed here.

  Background:
    Given an empty control plane
    And the Pi sessions bucket keeps every object version
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"

  Scenario: Erasing a message removes its text from the record, the mailbox and every version of the Pi session
    Given the model answers "Understood."
    And user "ryan" of tenant "anthus" posts "the launch code is kestrel-7" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    And every Pi session object is rewritten once, which leaves its earlier version behind
    And user "ryan" of tenant "anthus" posts "ignore the next line, it is a draft kestrel-7" on the channel without addressing a bot
    Then the text "kestrel-7" is held by:
      | channel record                      |
      | mailbox                             |
      | Pi session objects (current)        |
      | Pi session objects (older versions) |
    When user "ryan" of tenant "anthus" erases the message with seq 1
    And user "ryan" of tenant "anthus" erases the message with seq 3
    Then the erasure tombstoned the messages with seq "3"
    And the text "kestrel-7" is held nowhere
    And the Pi session of bot "Assistant" has no object versions or delete markers left from before
    And the channel lists the message with seq 1 as deleted with an empty body
    And the channel lists the message with seq 2 as deleted with an empty body
    And the channel lists the message with seq 3 as deleted with an empty body

  Scenario: The answer to an erased message is erased with it, and other messages survive
    Given the model answers "Understood."
    And user "ryan" of tenant "anthus" posts "keep this line, the picnic is on friday" on the channel without addressing a bot
    And user "ryan" of tenant "anthus" posts "the launch code is kestrel-7" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    When user "ryan" of tenant "anthus" erases the message with seq 2
    Then the erasure tombstoned the messages with seq "2, 3"
    And the channel lists the message with seq 3 as deleted with an empty body
    And the text "picnic is on friday" is held by:
      | channel record |
    When the model answers "Friday."
    And user "ryan" of tenant "anthus" posts "when is the picnic?" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    Then the Pi session of bot "Assistant" was rebuilt before it answered
    And the model's request 2 included "the picnic is on friday"
    And the text "picnic is on friday" is held by:
      | channel record               |
      | Pi session objects (current) |

  Scenario: The bot no longer sees an erased message on its next turn
    Given the model answers "Understood."
    And user "ryan" of tenant "anthus" posts "the launch code is kestrel-7" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    And user "ryan" of tenant "anthus" posts "the picnic is on friday" on the channel without addressing a bot
    And user "ryan" of tenant "anthus" erases the message with seq 1
    And the model answers "Friday."
    And user "ryan" of tenant "anthus" posts "when is the picnic?" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    Then the model's request 2 included "the picnic is on friday"
    And the model's request 2 included "when is the picnic?"
    And the model's request 2 did not include "kestrel-7"
    And the model's request 2 did not include "Understood."

  Scenario: A bot with a turn open keeps its session until the turn ends, and the erasure is finished then
    Given the model holds its first request
    And the model answers "Noted the code."
    When user "ryan" of tenant "anthus" posts "the launch code is kestrel-7" addressed to bot "Assistant" on the channel
    And bot "Assistant" starts a turn
    And the model is waiting on its first request
    And user "ryan" of tenant "anthus" erases the message with seq 1
    Then the erasure left the session of bot "Assistant" for later because its turn is open
    And the channel lists the message with seq 1 as deleted with an empty body
    And the text "kestrel-7" is held by:
      | Pi session objects (current) |
    When the model is released
    And the started turn finishes
    Then the finished turn asked for the pending erasure of the channel to be completed
    When the erasure worker takes the requests queued for it
    Then the text "kestrel-7" is held nowhere
    And the channel lists the message with seq 2 as deleted with an empty body

  Scenario: A message erased before its turn starts fails that turn, and the finished turn completes the erasure
    Given the model answers "Understood."
    And user "ryan" of tenant "anthus" posts "the launch code is kestrel-7" addressed to bot "Assistant" on the channel
    When user "ryan" of tenant "anthus" erases the message with seq 1
    Then the erasure left the session of bot "Assistant" for later because its turn is open
    When bot "Assistant" runs one computerless worker turn against that provider
    Then the turn has failed with reason "The message this turn was meant to answer is missing."
    And the channel has no bot answer
    And the finished turn asked for the pending erasure of the channel to be completed
    When the erasure worker takes the requests queued for it
    Then the text "kestrel-7" is held nowhere

  Scenario: A turn that ends with no erasure waiting asks for nothing
    Given the model answers "Understood."
    And user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    Then the finished turn asked for no erasure to be completed

  Scenario: A post made with an Idempotency-Key leaves no second copy of the text
    Given the model answers "Understood."
    And user "ryan" of tenant "anthus" posts "the launch code is kestrel-7" addressed to bot "Assistant" on the channel with idempotency key "post-1"
    And bot "Assistant" completes one turn
    Then the text "kestrel-7" is held by:
      | channel record               |
      | Pi session objects (current) |
    When user "ryan" of tenant "anthus" erases the message with seq 1
    Then the text "kestrel-7" is held nowhere

  Scenario: Erasing a message longer than one row removes every continuation item
    Given user "ryan" of tenant "anthus" posts a message of 700000 characters ending in "the code is zebra-9" on the channel without addressing a bot
    Then the text "zebra-9" is held by:
      | channel record |
    When user "ryan" of tenant "anthus" erases the message with seq 1
    Then the text "zebra-9" is held nowhere
    And the channel lists the message with seq 1 as deleted with an empty body

  Scenario: The scrub command reports old idempotency items by default and cleans them only when told to
    Given tenant "anthus" user "ryan" opens a named channel "notes" with no bot
    And an old post idempotency item holds the text "the old launch code is kestrel-7"
    When the operator tool runs "scrub-idempotency" on the scenario's stores
    Then the operator tool printed "dry-run holding_text=1 scrubbed=0"
    And the text "kestrel-7" is held by:
      | messaging table anthus/idem |
    When the operator tool runs "scrub-idempotency --execute" on the scenario's stores
    Then the operator tool printed "scrub-idempotency holding_text=1 scrubbed=1"
    And the text "kestrel-7" is held nowhere

  Scenario: What the erased answer's turn left in its events and its computer actions is swept too
    Given the model answers "The code word is osprey-3."
    And user "ryan" of tenant "anthus" posts "tell me the code word" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    And a computer action of the last turn of bot "Assistant" has the argument "echo osprey-3" and the result "osprey-3"
    Then the text "osprey-3" is held by:
      | channel record               |
      | Pi session objects (current) |
      | messaging table anthus/act   |
      | turn events                  |
    When user "ryan" of tenant "anthus" erases the message with seq 1
    Then the text "osprey-3" is held nowhere
    And the erasure swept the events and computer actions of 1 turn
