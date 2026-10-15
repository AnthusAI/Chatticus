Feature: The organization computer stays on between turns and switches itself off when nobody needs it
  As a household member
  I want the computer to keep running after a turn and answer my next message in seconds
  So that I do not wait for a cold start every time, and the computer still costs nothing while nobody works

  These scenarios run the real routes with the real supervisor loop. The contract is
  docs/OWNER_SUPERVISOR_PROTOCOL.md and the wire schemas are in
  host-protocol/src/supervisor.ts. The server's own scenarios are told in
  owner_supervisor_server.feature and computer_owner_start.feature, the credential
  broker's in owner_credential_broker.feature, and the supervisor's in
  computer_owner_supervisor.feature.

  A computer homed in the deployment account starts as a supervisor. The starter
  puts one value in the task, a bootstrap token that lives five minutes and works
  once, and assumes no role. The supervisor exchanges it for a supervisor token and
  for credentials that reach the computer's snapshot prefix and nothing else. It then
  asks the control plane for work every second to ten seconds; that call is also its
  heartbeat. When a turn is parked on the computer's action the control plane hands
  it to the supervisor with a gateway token and credentials for that one
  conversation, and the supervisor runs it in a child process that holds nothing
  else. After fifteen minutes without work the supervisor asks to stop and the
  control plane approves only if nothing is pending.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Analyst"
    And the organization is homed in the deployment account
    And a fake owner credential broker

  @end-to-end
  Scenario: A second turn is served by the live owner without a start
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/first.md", "content": "one"}
      """
    And the model is scripted to answer "First saved."
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/second.md", "content": "two"}
      """
    And the model is scripted to answer "Second saved."
    And a recording host start driver
    And a supervisor is running for the household computer
    When bot "Researcher" is asked "save the first file"
    And bot "Researcher" works its turn until it waits for the computer
    And the supervisor polls until it is served
    Then the turn ended "done"
    When bot "Analyst" is asked "save the second file"
    And bot "Analyst" works its turn until it waits for the computer
    Then no computer start job is queued
    When the supervisor polls until it is served
    Then the turn ended "done"
    And the host start driver was invoked once
    And the log has one "owner_started" line and two "owner_serving_turn" lines

  @end-to-end
  Scenario: A turn parked behind a busy owner waits and then runs
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "sleep 1", "cwd": "/workspace"}
      """
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/second.md", "content": "two"}
      """
    And the model is scripted to answer "Done waiting."
    And the model is scripted to answer "Second saved."
    And a supervisor is running for the household computer
    When bot "Researcher" is asked "wait a second"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And bot "Researcher" works its turn until it waits for the computer
    And the supervisor polls and its child is held mid-turn
    And bot "Analyst" is asked "save the second file"
    And bot "Analyst" works its turn until it waits for the computer
    And the supervisor polls
    Then the poll offered no dispatch
    And the turn of bot "Analyst" is still waiting for the computer
    When the held child is released and the supervisor polls until it is served
    Then the turn of bot "Researcher" ended "done"
    And the turn of bot "Analyst" ended "done"

  @end-to-end
  Scenario: A start job that arrives while the owner drains is acknowledged and the stopped report starts the next owner
    Given a supervisor is running for the household computer
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/late.md", "content": "late"}
      """
    And a recording host start driver
    And the owner was bootstrapped 3000 seconds ago
    When bot "Researcher" is asked "save a late file"
    And bot "Researcher" works its turn until it waits for the computer
    And a start job for the turn is delivered to the starter
    Then the start ended "already_serving"
    And the host start driver was not invoked
    When the supervisor polls
    Then the poll answered drain with reason "credentials" and no dispatch
    When the supervisor stops with reason "lifetime"
    Then a computer start job is queued for the turn
    When every queued start job is delivered to the starter
    Then the host start driver was invoked once

  @end-to-end
  Scenario: A child that crashes mid-turn leaves the turn to the lost-owner recovery
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo started >> runs.log", "cwd": "/workspace"}
      """
    And the model is scripted to answer "I could not confirm that the command finished."
    And a supervisor is running for the household computer
    When bot "Researcher" is asked "append a line to the run log"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And bot "Researcher" works its turn until it waits for the computer
    And the supervisor polls and its child is killed after its tool ran
    Then the supervisor logged "owner_child_exited" with clean "false"
    And the supervisor is still polling
    When the clock moves past the turn lease
    And the supervisor polls
    And the turn probe runs
    Then a run job is queued for the turn
    When a Lambda-style owner works the turn until it ends
    Then the turn ended "done"
    And the tool "run_terminal" was reported lost and not run again
