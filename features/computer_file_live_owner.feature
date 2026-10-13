Feature: The control plane hands file requests to the live owner and takes its answers

  As the operator of an organization computer
  I want a file request left by a member's route to reach the live owner in its poll, and its answer to come back once
  So that a person can see and change the files on the running computer without a connection that outlives a request

  This is the owner side of the live file protocol (docs/LIVE_FILES_PROTOCOL.md sections 6.1, 7.1 and 7.4; the wire
  schemas are in host-protocol/src/live-files.ts). A member's route leaves a request in the table, in one transaction
  with the computer record, for the one owner it names. The owner receives the request in its next poll, only if it
  speaks protocol 2, is in a state that can serve a file and has no approved stop; the request is delivered once, by a
  conditional write, and again only for a repeat of the same poll. The owner posts one answer on a fixed route; the
  answer is accepted only from the owner that was given the request, once, and finishes the audit record the Front Door
  wrote first. An open Files panel makes the owner poll every second without keeping the computer awake, and a file
  request that is waiting or being served vetoes an idle stop. The member routes themselves are in
  computer_file_live.feature.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has computer "household-computer"
    And a fake owner credential broker

  # ---------------------------------------------------------------- the poll hands a request over

  @server
  Scenario: The poll delivers a file request once and again only when the poll is repeated
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    When the owner polls
    Then the poll response carries one file request
    When the owner repeats the poll it did not hear back
    Then the poll response carries the same file request
    When the owner polls with the next sequence number
    Then the poll response carries no file request

  @server
  Scenario: A delivered request tells the owner how long it has left
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    When 2 seconds pass at the control plane
    And the owner polls
    Then the poll response carries one file request that expires in 6000 milliseconds

  @server
  Scenario: A request that has waited out its eight seconds is not handed to the owner
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    When 9 seconds pass at the control plane
    And the owner polls
    Then the poll response carries no file request

  @server
  Scenario: A request is not handed to an owner that is stopping
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    When the owner polls reporting state "stopping"
    Then the poll response carries no file request

  @server
  Scenario: A request is not handed to an owner that predates file operations
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    When the owner polls speaking protocol version 1
    Then the poll response carries no file request

  @server
  Scenario: A request is not handed to an owner that is still hydrating
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    When the owner polls reporting state "hydrating"
    Then the poll response carries no file request

  # ---------------------------------------------------------------- the owner answers

  @server
  Scenario: A result from an owner that was not given the operation is refused
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    And the owner polls
    When another owner of the same organization posts a result for that operation
    Then the result is refused with code "operation_closed"

  @server
  Scenario: A result for an abandoned operation is refused
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    When the Front Door abandons the request that member "mia" is waiting for
    And the owner posts a result for that operation
    Then the result is refused with code "operation_closed"

  @server
  Scenario: A result is recorded once
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    And the owner polls
    When the owner posts a result for that operation
    And the owner posts the same result again
    Then the result is acknowledged and nothing changes

  @server
  Scenario: A second result with different content is refused
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    And the owner polls
    And the owner posts a result for that operation
    When the owner posts a different result for that operation
    Then the result is refused with code "operation_closed"

  @server
  Scenario: A result for a request that was never delivered is refused
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    When the owner posts a result for that operation
    Then the result is refused with code "operation_closed"

  @server
  Scenario: A result that does not parse is refused
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    When the owner polls
    And the owner posts a result that claims a read answered a write
    Then the result is refused with code "invalid_request"

  @server
  Scenario: A result that arrives after the waiting request gave up is recorded and leaves nothing in the table
    Given a live owner is polling for the household computer
    And member "mia" has a write of "second draft" to "/workspace/notes.md" pending that the owner has not taken, with its audit record
    And the owner polls
    When the Front Door stops waiting for the write the owner took
    And the owner answers the write it was given
    Then the result is acknowledged
    And no file request is left in the table
    And the audit log has one record for member "mia" with outcome "ok"

  @server
  Scenario: A result finishes the audit record the Front Door wrote first
    Given a live owner is polling for the household computer
    And member "mia" has a write of "second draft" to "/workspace/notes.md" pending that the owner has not taken, with its audit record
    And the audit log has one record for member "mia" with outcome "pending"
    And the owner polls
    When the owner answers the write it was given
    Then the audit log has one record for member "mia" with outcome "ok"
    And the audit record names the resolved path "/workspace/notes.md"
    And the audit record carries no flag

  @server
  Scenario: A conflict reported by the owner is audited as a conflict
    Given a live owner is polling for the household computer
    And member "mia" has a write of "second draft" to "/workspace/notes.md" pending that the owner has not taken, with its audit record
    And the owner polls
    When the owner answers the write with the error "precondition_failed"
    Then the audit log has one record for member "mia" with outcome "conflict"
    And the audit record carries the error code "precondition_failed"

  @server
  Scenario: An owner whose hashes disagree with what was sent is flagged in the audit record
    Given a live owner is polling for the household computer
    And member "mia" has a write of "second draft" to "/workspace/notes.md" pending that the owner has not taken, with its audit record
    And the owner polls
    When the owner answers the write reporting the hash of "something else" as the new hash
    Then the audit log has one record for member "mia" with the flag "integrity_mismatch"

  # ---------------------------------------------------------------- the panel makes the owner poll fast

  @server
  Scenario: An open panel makes the owner poll every second
    Given a live owner that has been idle for 10 minutes and polls every 10 seconds
    When a member's Files panel tells the computer it is open
    Then the response says the computer is live
    And the next poll of the owner is answered with a pace of 1 second

  @server
  Scenario: The owner returns to its normal pace after the panel closes
    Given a live owner that has been idle for 10 minutes and polls every 10 seconds
    And a member's Files panel told the computer it is open
    When 46 seconds go by without another message from the panel
    Then the next poll of the owner is answered with a pace of 10 seconds

  @server
  Scenario: A panel that says it is closed ends the fast pace at once
    Given a live owner that has been idle for 10 minutes and polls every 10 seconds
    And a member's Files panel told the computer it is open
    When the panel tells the computer it is closed
    Then the next poll of the owner is answered with a pace of 10 seconds

  @server
  Scenario: A busy owner polls every second while a panel is open
    Given a live owner that is serving a turn and polls every 5 seconds
    When a member's Files panel tells the computer it is open
    Then the next poll of the owner is answered with a pace of 1 second

  @server
  Scenario: A panel that is open does not keep the computer awake
    Given a live owner that has been idle for 14 minutes
    And a member's Files panel told the computer it is open 30 seconds ago
    When the owner asks to stop because it has been idle
    Then the stop is approved

  @server
  Scenario: A panel that is open when the computer is off learns it and starts nothing
    Given no owner is running
    When a member's Files panel tells the computer it is open
    Then the response says the computer is off
    And no file request was left for the owner
    And no computer start job is queued

  # ---------------------------------------------------------------- a file request and an idle stop

  @server
  Scenario: An idle stop is vetoed while a file operation is pending
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    When the owner asks to stop because it has been idle
    Then the stop is vetoed with reason "file_operation_pending"

  @server
  Scenario: An idle stop is vetoed while the owner is serving a file operation
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    And the owner polls
    When the owner asks to stop because it has been idle
    Then the stop is vetoed with reason "file_operation_pending"

  @server
  Scenario: An idle stop is approved again once the file operation is answered
    Given a live owner is polling for the household computer
    And member "mia" has a file request pending that the owner has not taken
    And the owner polls
    And the owner posts a result for that operation
    When the owner asks to stop because it has been idle
    Then the stop is approved

  @server
  Scenario: A stop and a file operation cannot both win
    Given a live owner is polling for the household computer
    When the owner's idle stop is approved between a member's request being judged and being queued
    Then the member's file request is not queued
    And queueing it was refused because the owner is stopping

  @server
  Scenario: A request queued after a stop was judged defeats the approval
    Given a live owner is polling for the household computer
    When a member's request is queued between the owner's idle stop being judged and being approved
    Then the stop is vetoed with reason "file_operation_pending"

  # ---------------------------------------------------------------- the owner cannot reach the records

  @server
  Scenario: The owner cannot read the audit log
    Then the per-turn role policy denies every DynamoDB action on the key family "anthus#computer#audit"
    And the supervisor role policy denies every DynamoDB action
    And no owner route returns an audit record

  @server
  Scenario: The owner cannot read or write the file operation records directly
    Then the per-turn role policy denies every DynamoDB action on the key family "anthus#computer#fileops"
    And the supervisor role policy denies every DynamoDB action
