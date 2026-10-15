Feature: A bot turn runs on the conversation engine and commits one final answer
  As a household member
  I want a bot to read the channel, do its work and answer once
  So that the channel shows one clear answer however many steps the work took

  A turn is executed by exactly one owner of the bot's conversation. The
  owner brings the conversation up to the channel, runs the model, shows
  progress as it happens, takes in messages posted to the same bot while it
  works, and finishes by committing only the final answer to the channel.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"

  Scenario: Only the final answer is committed to the channel
    Given the model says "Let me write that down." and calls the note tool with "remember the milk" and then answers "Noted: remember the milk."
    When user "ryan" of tenant "anthus" posts "please remember the milk" addressed to bot "Assistant" on the channel
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    And bot "Assistant" completes one turn
    Then the channel has exactly one bot answer with body "Noted: remember the milk."
    And the streamed text of the turn is "Let me write that down.Noted: remember the milk."
    And the turn events show a call to tool "note_to_channel" and its result before completion
    And the completed event names the sequence of the bot answer

  Scenario: Streamed text reaches the watcher in order and the stream ends on the terminal event
    Given the model answers with a reply of 600 characters
    When user "ryan" of tenant "anthus" posts "tell me a long story" addressed to bot "Assistant" on the channel
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    And bot "Assistant" completes one turn
    Then user "ryan" receives the whole reply as turn tokens in order
    And the turn events have integer sequences from 1 with no gaps
    And the last event of the turn is "turn.completed"

  Scenario: A message posted to the same bot while it works steers the running turn
    Given the model calls the note tool with "outline" and then answers "Outline done, with totals."
    And the model holds its first request
    When user "ryan" of tenant "anthus" posts "start the report" addressed to bot "Assistant" on the channel
    And the open turn is remembered as "report"
    And bot "Assistant" starts a turn
    And the model is waiting on its first request
    And user "ryan" of tenant "anthus" posts "and include totals" addressed to bot "Assistant" on the channel
    And the steered message has been taken into the conversation
    And the model is released
    And the started turn finishes
    Then the last post joined the turn remembered as "report"
    And the model received 2 requests
    And the model's request 2 included "and include totals"
    And the channel has exactly one bot answer with body "Outline done, with totals."

  Scenario: Lines posted without addressing the bot reach it as context before the question
    Given the model answers "Lunch is at noon."
    When user "ryan" of tenant "anthus" posts "lunch is at noon" on the channel without addressing a bot
    And user "ryan" of tenant "anthus" posts "when is lunch?" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    Then the model's request 1 included "lunch is at noon" before "when is lunch?"
    And the message with seq 1 has body "lunch is at noon"
    And the message with seq 2 has body "when is lunch?"
    And the message with seq 3 is from bot "Assistant"

  Scenario: A bot's reply is shown to the other bots on the channel
    Given tenant "anthus" user "ryan" has a bot named "Writer"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Assistant |
      | Writer    |
    And the model answers "The top ten accounts are in the spreadsheet."
    And user "ryan" of tenant "anthus" posts "find the top ten accounts" addressed to bot "Assistant" on the channel
    And bot "Assistant" completes one turn
    And the model answers "Here is the summary."
    And user "ryan" of tenant "anthus" posts "summarize that" addressed to bot "Writer" on the channel
    And bot "Writer" completes one turn
    Then the model's request 2 included "The top ten accounts are in the spreadsheet."
    And the channel has 4 messages

  Scenario: An uncertain commit hands the turn to reconciliation instead of failing it
    Given the model answers "This answer may or may not be saved."
    And the model holds its first request
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    And bot "Assistant" starts a turn
    And the model is waiting on its first request
    And the conversation store stops confirming writes
    And the model is released
    And the started turn finishes
    Then the turn is reconciling
    And user "ryan" receives a reconciling server-sent event
    And the channel has no bot answer
