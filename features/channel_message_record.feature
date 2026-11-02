Feature: Every channel message lives in the channel's own record
  As a member of an organization
  I want a channel to keep its messages itself, whatever bots are on it
  So that a channel with no bot works, a bot that joins late can read what came before, and a bot's mailbox is only a delivery queue

  A channel's record is the one place its messages are listed from. Posting a
  message writes it to the record before it is delivered to anyone. A bot's answer
  reaches the record when its turn ends, with the tool calls the turn made. A bot's
  mailbox holds the messages it has not read yet and is emptied as the bot reads
  them; the record keeps them.

  Background:
    Given an empty control plane

  Scenario: A channel with no bot takes posts and lists them in order
    Given tenant "anthus" user "ryan" opens a named channel "notes" with no bot
    When user "ryan" of tenant "anthus" posts "first thought" on the channel without addressing a bot
    And user "ryan" of tenant "anthus" posts "second thought" on the channel without addressing a bot
    Then the channel lists these messages in order:
      | first thought  |
      | second thought |
    And the channel record is the only place the listing reads

  Scenario: A bot's mailbox is emptied when it reads, and the record keeps the message
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And the model answers "Understood."
    When user "ryan" of tenant "anthus" posts "plan the launch" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    Then the mailbox of bot "Assistant" on the channel is empty
    And the channel lists these messages in order:
      | plan the launch |
      | Understood.     |

  Scenario: A bot's answer is listed after the message it answers, with the tool calls the turn made
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And the model calls the note tool with "launch is on the 14th" and then answers "Noted the date."
    When user "ryan" of tenant "anthus" posts "when is the launch?" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    Then the channel lists these messages in order:
      | when is the launch? |
      | Noted the date.     |
    And the last bot answer lists a call to tool "note_to_channel"

  Scenario: A bot that joins a channel later finds the earlier messages in the record
    Given tenant "anthus" user "ryan" opens a named channel "notes" with no bot
    And tenant "anthus" user "ryan" has a bot named "Researcher" that is not on the channel yet
    And user "ryan" of tenant "anthus" posts "the budget is fixed" on the channel without addressing a bot
    And user "ryan" of tenant "anthus" posts "the date is not" on the channel without addressing a bot
    When bot "Researcher" joins the channel
    Then the channel lists these messages in order:
      | the budget is fixed |
      | the date is not     |
    And the mailbox of bot "Researcher" on the channel is empty

  Scenario: A bot that joins a channel later answers with the earlier messages in its context
    Given tenant "anthus" user "ryan" opens a named channel "notes" with no bot
    And tenant "anthus" user "ryan" has a bot named "Researcher" that is not on the channel yet
    And user "ryan" of tenant "anthus" posts "the budget is fixed" on the channel without addressing a bot
    And user "ryan" of tenant "anthus" posts "the date is not" on the channel without addressing a bot
    And bot "Researcher" joins the channel
    And the model answers "Noted."
    When user "ryan" of tenant "anthus" posts "what do we know?" addressed to bot "Researcher" on the channel
    And bot "Researcher" completes one turn
    Then the model's request 1 included "the budget is fixed" before "the date is not"
    And the model's request 1 included "what do we know?"

  Scenario: A channel from before the record is filled in from its bot sessions, and nothing is lost
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And the model calls the note tool with "remember the milk" and then answers "Noted."
    And user "ryan" of tenant "anthus" posts "background first" on the channel without addressing a bot
    And user "ryan" of tenant "anthus" posts "please note something" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    And the channel record is emptied, as it was before the record existed
    And the per-call cost copies are removed, as they were before they existed
    Then the channel lists 0 messages
    And the per-call cost records of the last turn of bot "Assistant" can no longer be found
    When the channel record is backfilled
    Then the backfill wrote 3 messages
    And the per-call cost records of the last turn of bot "Assistant" can be read
    And the channel lists these messages in order:
      | background first      |
      | please note something |
      | Noted.                |
    And the last bot answer lists a call to tool "note_to_channel"
    And the record rows match what the bot sessions held, activity included
    When the channel record is backfilled
    Then the backfill wrote 0 messages
    And the backfill found 3 messages already in the record

  Scenario: Reading a long channel from the record takes fewer requests than merging the bot sessions
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And the model answers "All read."
    When user "ryan" of tenant "anthus" posts 98 messages without addressing a bot
    And user "ryan" of tenant "anthus" posts "and now the question" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    And the channel is read from the record and by merging the bot sessions, counting requests
    Then the channel lists 100 messages
    And reading the record takes fewer DynamoDB requests and no S3 requests compared with the merge

  Scenario: A message longer than one row is kept whole and listed whole
    Given tenant "anthus" user "ryan" opens a named channel "notes" with no bot
    When user "ryan" of tenant "anthus" posts a message of 700000 characters ending in "the very end" on the channel without addressing a bot
    And user "ryan" of tenant "anthus" posts "a short one" on the channel without addressing a bot
    Then the channel lists 2 messages
    And the channel record is the only place the listing reads

  Scenario: A long message lists whole
    Given tenant "anthus" user "ryan" opens a named channel "notes" with no bot
    When user "ryan" of tenant "anthus" posts a message of 700000 characters ending in "the very end" on the channel without addressing a bot
    Then the last listed message has 700000 characters and ends in "the very end"

  Scenario: A long message addressed to a bot reaches the bot whole, through a mailbox that holds only a pointer
    Given tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And the model answers "Read it."
    When user "ryan" of tenant "anthus" posts a message of 400000 characters ending in "the very end" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    Then the model's request 1 included "the very end"
    And the channel lists 2 messages

  Scenario: A message longer than the record keeps is refused and writes nothing
    Given tenant "anthus" user "ryan" opens a named channel "notes" with no bot
    When user "ryan" of tenant "anthus" posts a message of 2000001 characters ending in "too long" on the channel without addressing a bot
    Then the last post was refused with status 413
    And the channel lists 0 messages
