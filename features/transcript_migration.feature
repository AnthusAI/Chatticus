Feature: The old transcripts move into per-bot Pi sessions without changing what anyone sees
  As the operator of Chatticus
  I want every channel's history copied from the old control plane's items into one Pi session per bot per channel
  So that after the cutover each bot's next turn sees the history and the message list shows the same messages

  The old control plane stored a channel's messages, its turns and its latest-turn pointers as items in the
  Messaging table. The migration tool reads those items exactly as the old control plane wrote them and writes the
  new shape: a Pi session for every bot on every channel, a channel log that keeps each message's original sequence
  number, message id and timestamp, and turn records with their status and reason. The copy is repeatable and never
  deletes an old item. A short window with the write gate closed picks up what was posted last.

  Background:
    Given the old control plane left the transcripts of tenant "anthus" in the messaging table
    And the front door is running with the migration write gate
    And the operator tool is configured for the scenario's stores

  Scenario: A dry run says what would be written and writes nothing
    When the operator runs "copy --dry-run --environment development" with the real command line tool
    Then the command succeeds
    And the command output includes "dry-run tenant=anthus channel=chan-general bots=2 messages=6 would_write=12 assistant_entries=2 attributed_entries=10"
    And the command output includes "dry-run tenant=anthus channel=chan-direct bots=1 messages=3 would_write=3 assistant_entries=1 attributed_entries=2"
    And the migration has written no session and no marker

  Scenario: The tool refuses to run without a named environment
    When the operator runs "copy" with the real command line tool
    Then the command fails with exit code 2
    And the command error includes "--environment must be one of development, staging, production"

  Scenario: The copy gives the message list exactly the old sequence numbers, authors, bodies and timestamps
    When the operator runs "copy"
    Then the command succeeds
    And the message list of channel "chan-general" shows exactly the old messages of that channel
    And the message list of channel "chan-direct" shows exactly the old messages of that channel
    And the next sequence number of channel "chan-general" is still 7
    And the old message items of channel "chan-general" are all still there

  Scenario: The next turn of a bot sees the migrated history in its own session
    Given the operator has run the copy
    And the model answers "I will remind you at 2:30."
    When user "ryan" of tenant "anthus" posts "what did Bo book?" addressed to bot "Ada" on the channel
    And bot "Ada" completes one turn
    Then the model's request 1 shows "ryan: Good morning team. Lunch is at noon." as a user message
    And the model's request 1 shows "Two meetings: standup at ten and review at three." as an assistant message
    And the model's request 1 shows "bo: Booked room 4 for the three o'clock review." as a user message
    And the message with seq 7 has body "what did Bo book?"
    And the message with seq 8 is from bot "Ada"

  Scenario: Another bot sees the answer of its colleague as an attributed line
    Given the operator has run the copy
    And the model answers "The room is booked."
    When user "ryan" of tenant "anthus" posts "Bo, is the room still booked?" addressed to bot "Bo" on the channel
    And bot "Bo" completes one turn
    Then the model's request 1 shows "ada: Two meetings: standup at ten and review at three." as a user message
    And the model's request 1 shows "Booked room 4 for the three o'clock review." as an assistant message
    And the message with seq 7 has body "Bo, is the room still booked?"

  Scenario: Running the copy twice writes nothing the second time and claims no new fence
    When the operator runs "copy"
    And the operator runs "copy"
    Then the command output includes "copy tenant=anthus channel=chan-general bots=2 messages=6 written=0"
    And the Pi fence of bot "ada" in channel "chan-general" is 1
    And the message list of channel "chan-general" shows exactly the old messages of that channel

  Scenario: A copy records when each session was last brought up to date
    Given the clock is at "2026-09-02T03:00:00Z"
    When the operator runs "copy"
    Then the marker of bot "ada" in channel "chan-general" records 6 messages up to seq 6 by the "copy" pass at "2026-09-02T03:00:00+00:00"

  Scenario: The delta pass picks up what the old system accepted after the copy
    Given the operator has run the copy
    And the old system accepted two more messages after the copy
    And the clock is at "2026-09-02T04:30:00Z"
    And the operator closes the write gate
    When the operator runs "delta"
    Then the command succeeds
    And the command output includes "active_failed=1"
    And the command output includes "verify tenant=anthus channel=chan-general ok old=8 listed=8"
    And the message list of channel "chan-general" shows exactly the old messages of that channel
    And the marker of bot "bo" in channel "chan-general" records 8 messages up to seq 8 by the "delta" pass at "2026-09-02T04:30:00+00:00"

  Scenario: The delta pass refuses to run while the write gate is open
    Given the operator has run the copy
    And the old system accepted two more messages after the copy
    When the operator runs "delta"
    Then the command fails with exit code 2
    And the command error includes "delta needs the write gate closed"
    And the message list of channel "chan-general" shows 6 messages

  Scenario: Verify passes when the new read paths agree with the old items
    Given the operator has run the copy
    And the operator closes the write gate
    When the operator runs "latest-turns"
    And the operator runs "verify"
    Then the command succeeds
    And the command output includes "verify tenant=anthus channel=chan-general ok old=6 listed=6"

  Scenario: A passing verification leaves the marker the day-14 purge trusts
    Given the clock is at "2026-09-02T05:00:00Z"
    And the operator has run the copy
    And the operator closes the write gate
    When the operator runs "latest-turns"
    And the operator runs "verify"
    Then the verified marker of channel "chan-general" records 6 messages up to seq 6 at "2026-09-02T05:00:00+00:00"

  Scenario: A failing verification leaves no verified marker
    Given the operator has run the copy
    And the old system edited the body of message 3 in channel "chan-general" to "Edited afterwards."
    When the operator runs "verify"
    Then the command fails with exit code 1
    And channel "chan-general" has no verified marker

  Scenario: Verify fails before anything was copied
    When the operator runs "verify"
    Then the command fails with exit code 1
    And the command output includes "session of bot ada holds 0 of 6 old messages"

  Scenario: Verify names a message that was edited in the old system after the copy
    Given the operator has run the copy
    And the old system edited the body of message 3 in channel "chan-general" to "Edited afterwards."
    When the operator runs "verify"
    Then the command fails with exit code 1
    And the command output includes "message seq 3 differs in body"

  Scenario: A finished turn keeps its status and reason after the migration
    Given the operator has run the copy
    When the operator runs "latest-turns"
    Then the latest turn of channel "chan-direct" is "failed" with reason "model_provider_error"
    And the latest turn of bot "Bo" in channel "chan-general" is "completed"
    And the completed turn "turn-4" names the answer with seq 2

  Scenario: A turn still active when the write gate closes is failed with a clear reason
    Given the operator has run the copy
    And the operator closes the write gate
    When the operator runs "latest-turns"
    Then the command output includes "tenant=anthus channel=chan-general turns=3 converted=2 already=0 active_failed=1 active_left=0"
    And the latest turn of bot "Ada" in channel "chan-general" is "failed" with reason "interrupted_by_transcript_migration"

  Scenario: A turn that is active while the write gate is open is left running
    Given the operator has run the copy
    When the operator runs "latest-turns"
    Then the command output includes "active_failed=0 active_left=1"
    And turn "turn-3" is still "active"

  Scenario: Converting the turns twice changes nothing the second time
    Given the operator has run the copy
    And the operator closes the write gate
    When the operator runs "latest-turns"
    And the operator runs "latest-turns"
    Then the command output includes "tenant=anthus channel=chan-general turns=3 converted=0 already=3 active_failed=0 active_left=0"

  Scenario: Writes are refused with a clear message while the write gate is closed
    Given the operator closes the write gate
    When user "ryan" of tenant "anthus" posts "anyone there?" addressed to bot "Ada" on the channel
    Then the last post is refused with status 503 saying "read-only"
    And the next sequence number of channel "chan-general" is still 7
    And reading the message list of channel "chan-general" still works

  Scenario: Writes are accepted again once the write gate is open
    Given the operator closes the write gate
    And the operator opens the write gate
    When user "ryan" of tenant "anthus" posts "anyone there?" addressed to bot "Ada" on the channel
    Then the last post is accepted
