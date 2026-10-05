Feature: Channel messages reach every bot session through a mailbox and a log
  As the Chatticus control plane
  I want each message to get one channel-wide number, wait in each bot's mailbox, and be recorded in that bot's session
  So that a channel can be listed in order without owning any session, and a message sent while a bot is busy steers it

  Scenario: Messages in a channel are numbered one at a time
    When 3 messages are numbered in channel "general"
    Then the numbers are 1, 2 and 3

  Scenario: Messages numbered at the same moment never share a number
    When 6 messages are numbered at the same time in channel "general"
    Then the numbers are 1, 2, 3, 4, 5 and 6

  Scenario: A mailbox is read in order whatever order the messages arrived in
    Given mailbox messages 3, 1 and 2 for bot "ada" in channel "general"
    When the mailbox of bot "ada" in channel "general" is listed after message 1
    Then the listed message numbers are 2 and 3

  Scenario: Putting the same message in a mailbox twice leaves one item
    Given mailbox messages 1 and 1 for bot "ada" in channel "general"
    Then the mailbox of bot "ada" in channel "general" holds 1 message

  Scenario: A different message cannot take a number a mailbox already holds
    Given mailbox messages 1 for bot "ada" in channel "general"
    When a different message is put at number 1 in the mailbox of bot "ada" in channel "general"
    Then the mailbox put fails because that number is taken

  Scenario: A mailbox item is removed only after its handler succeeds
    Given mailbox messages 1, 2 and 3 for bot "ada" in channel "general"
    When the mailbox of bot "ada" in channel "general" is drained and handling message 2 fails
    Then the mailbox of bot "ada" in channel "general" holds messages 2 and 3
    When the mailbox of bot "ada" in channel "general" is drained successfully
    Then the mailbox of bot "ada" in channel "general" holds 0 messages

  Scenario: A message written to a session is recorded in its log in the same commit
    Given an owner holds the session of bot "ada" in channel "general"
    When the owner writes message 1 from human "ryan" saying "hello team"
    Then the log of bot "ada" in channel "general" lists message 1 from "ryan"
    And the entry of message 1 in the session of bot "ada" reads "hello team" attributed to "ryan"
    And the model was not called

  Scenario: Writing the same message twice records it once
    Given an owner holds the session of bot "ada" in channel "general"
    When the owner writes message 1 from human "ryan" saying "hello team"
    And the owner writes message 1 from human "ryan" saying "hello team"
    Then the log of bot "ada" in channel "general" holds 1 line

  Scenario: A write submitted through the session inbox is added to the log once
    Given an owner holds the session of bot "ada" in channel "general"
    When the owner submits message 1 from human "ryan" saying "hello team" as a write
    And the log is reconciled for message 1
    And the log is reconciled for message 1
    Then the log of bot "ada" in channel "general" holds 1 line
    And the entry of message 1 in the session of bot "ada" reads "hello team" attributed to "ryan"
    And the model was not called

  Scenario: An input the session answered is added to the log once however often it is reconciled
    Given an owner holds the session of bot "ada" in channel "general"
    And the bot "ada" answers "Hello Ryan"
    When the owner submits message 1 from human "ryan" saying "hi ada" as an input
    And the log is reconciled for message 1
    And the log is reconciled for message 1
    Then the log of bot "ada" in channel "general" holds 1 line
    And the log line of message 1 points at an entry reading "hi ada"

  Scenario: Submitting the same request twice does not prompt the bot twice
    Given an owner holds the session of bot "ada" in channel "general"
    And the bot "ada" answers "Hello Ryan"
    When the owner submits message 1 from human "ryan" saying "hi ada" as an input
    And the owner submits message 1 from human "ryan" saying "hi ada" as an input
    Then both submissions are the same submission
    And the model was called 1 time

  Scenario: A second message to a busy bot steers the running turn
    Given an owner holds the session of bot "ada" in channel "general"
    And the bot "ada" is busy with a tool round
    When the owner starts message 1 from human "ryan" saying "start the report" as an input
    And message 2 from human "ryan" saying "use metric units" is submitted to the busy bot as a steer
    And the tool round finishes
    Then the turn is answered once
    And the model request that followed the tool round carried "use metric units"

  Scenario: A session can be read while another owner holds it, without taking it over
    Given an owner holds the session of bot "ada" in channel "general"
    And the owner writes message 1 from human "ryan" saying "hello team"
    When the session of bot "ada" in channel "general" is read without owning it
    Then the read sees message 1 reading "hello team"
    And the owner can still commit

  Scenario: Listing a channel merges every session log and mailbox
    Given bots "ada" and "bob" are in channel "general"
    And message 1 from human "ryan" saying "plan the launch" waits in both mailboxes
    And the bot "ada" answers "Draft ready"
    When bot "ada" drains its mailbox into its session as an input and its answer is logged as message 2
    And the channel "general" is listed
    Then the listed messages are 1 from "ryan" saying "plan the launch" and 2 from "ada" saying "Draft ready"
    When the channel "general" is listed after message 1
    Then the listed messages are 2 from "ada" saying "Draft ready"
