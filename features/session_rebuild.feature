Feature: A bot's Pi session can be dropped and rebuilt from the channel record
  As the owner of a Chatticus deployment
  I want a bot's session to be a copy of what the channel record holds
  So that dropping a session loses only what the record never kept, and I can say plainly what that is

  A rebuilt session holds every message of the channel as text: other authors as
  attributed lines, the bot's own earlier answers as its answers. It holds nothing else.
  The tool calls of past turns stay in the record as the activity of the answer they
  ended, so the channel still shows them, but the model no longer reads their results.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"

  Scenario: After a rebuild the model reads the channel's text and its own answers, and not the tool results of earlier turns
    Given the model calls the note tool with "the vault code is osprey-3" and then answers "Filed it."
    And user "ryan" of tenant "anthus" posts "please file the vault code" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    Then the model's request 2 included "osprey-3"
    And the model's request 2 included "toolResult"
    When the session of bot "Assistant" is dropped and rebuilt from the record, counting requests
    And the model answers "You filed it."
    And user "ryan" of tenant "anthus" posts "what did you do?" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    Then the model's request 3 included "please file the vault code"
    And the model's request 3 included "Filed it."
    And the model's request 3 included "what did you do?"
    And the model's request 3 did not include "toolResult"
    And the model's request 3 did not include "osprey-3"

  Scenario: The channel still lists the tool calls of a turn after the session that ran it is gone
    Given the model calls the note tool with "the vault code is osprey-3" and then answers "Filed it."
    And user "ryan" of tenant "anthus" posts "please file the vault code" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    When the session of bot "Assistant" is dropped and rebuilt from the record, counting requests
    Then the last bot answer lists a call to tool "note_to_channel"
    And the channel lists these messages in order:
      | please file the vault code |
      | Filed it.                  |

  Scenario: The per-call cost records of a turn outlive the session that ran it
    Given the model answers "Filed it."
    And user "ryan" of tenant "anthus" posts "please file the vault code" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    Then the per-call cost records of the last turn of bot "Assistant" can be read
    When the session of bot "Assistant" is dropped and rebuilt from the record, counting requests
    Then the per-call cost records of the last turn of bot "Assistant" can be read

  Scenario: A channel of 200 messages is rebuilt
    Given the model answers "All read."
    When user "ryan" of tenant "anthus" posts 198 messages without addressing a bot
    And user "ryan" of tenant "anthus" posts "and now the question" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    And the session of bot "Assistant" is dropped and rebuilt from the record, counting requests
    Then the Pi session of bot "Assistant" holds 200 channel log lines
