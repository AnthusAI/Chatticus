Feature: The organization computer stays on between turns and switches itself off when nobody needs it
  As a household member
  I want the computer to keep running after a turn and answer my next message in seconds
  So that I do not wait for a cold start every time, and the computer still costs nothing while nobody works

  DRAFT. The steps of these scenarios do not exist yet; the implementers write them
  with their parts and add this file to features/cucumber-features.txt in the same
  change. The contract is docs/OWNER_SUPERVISOR_PROTOCOL.md and the wire schemas are
  in host-protocol/src/supervisor.ts. Tags name who writes the steps. The server
  scenarios (routes, stores, start check) are told in owner_supervisor_server.feature
  and the starter's in computer_owner_start.feature. The tag "broker" covers the
  credential broker and the roles; "supervisor" the program in the container,
  with a fake Front Door, clock and process table; "end-to-end" the real routes
  with the real supervisor loop.

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
    And the model is scripted to answer "Done waiting."
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/second.md", "content": "two"}
      """
    And the model is scripted to answer "Second saved."
    And a supervisor is running for the household computer
    And the member allows the turn tools "run_terminal" under "/workspace"
    When bot "Researcher" is asked "wait a second"
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
    And the clock has moved 3000 seconds past the owner's bootstrap
    When bot "Researcher" is asked "save a late file"
    And bot "Researcher" works its turn until it waits for the computer
    And a start job for the turn is delivered to the starter
    Then the start ended "already_serving"
    And the host start driver was not invoked
    When the supervisor polls
    Then the poll answered drain with reason "lifetime" and no dispatch
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
    And the member allows the turn tools "run_terminal" under "/workspace"
    When bot "Researcher" is asked "append a line to the run log"
    And bot "Researcher" works its turn until it waits for the computer
    And the supervisor polls and its child is killed after its tool ran
    Then the supervisor logged "owner_child_exited" with clean "false"
    And the supervisor is still polling
    When the clock moves past the turn lease
    And the turn probe runs
    Then a run job is queued for the turn
    When a Lambda-style owner works the turn until it ends
    Then the turn ended "done"
    And the tool "run_terminal" was reported lost and not run again

  @broker
  Scenario: The broker issues supervisor credentials for the owner a bootstrap token names
    Given the broker holds the signing key
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the role "ComputerSupervisorRole" was assumed for 3600 seconds
    And the session tags are exactly "tenant" and "computer"
    And the assume-role call carries no session policy
    And the answer holds a supervisor token for the audience "computer-owner" that names no turn
    And the credentials, the token and the token's expiry end at the same moment

  @broker
  Scenario: The broker issues turn credentials with the five tags and a gateway token
    Given the broker holds the signing key
    When the broker is asked for turn credentials for bot "bot-1", channel "channel-1" and turn "turn-1" with a valid supervisor token
    Then the role "ComputerOwnerScopedRole" was assumed for 3600 seconds
    And the session tags are exactly "tenant", "bot", "channel", "computer" and "turn"
    And the answer holds a gateway token for the audience "model-gateway" bound to the turn, the bot and the owner id

  @broker
  Scenario Outline: The broker refuses what it should not issue
    Given the broker holds the signing key
    When the broker is asked for <purpose> credentials and <fault>
    Then the broker answers not ok with the code "<code>"
    And STS was not asked to assume a role

    Examples:
      | purpose    | fault                                                          | code                   |
      | supervisor | the authorization is a supervisor token                        | invalid_authorization  |
      | supervisor | the authorization is expired                                   | invalid_authorization  |
      | supervisor | the authorization names another owner than the payload         | authorization_mismatch |
      | supervisor | the authorization names another generation than the payload    | authorization_mismatch |
      | turn       | the authorization is a bootstrap token                         | invalid_authorization  |
      | turn       | the authorization names another organization than the payload  | authorization_mismatch |
      | turn       | the bot id is "bot 1"                                          | unsafe_tag_value       |
      | turn       | the payload has no turn                                        | invalid_request        |
      | supervisor | the payload names a turn                                       | invalid_request        |
      | turn       | the payload version is 2                                       | invalid_request        |

  @broker
  Scenario: The broker reports an STS failure by name only
    Given the broker holds the signing key
    And STS refuses the assume-role call with the error "AccessDenied"
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the broker answers not ok with the code "assume_role_failed"
    And the message is "AccessDenied" and holds no token, key or credential

  @broker
  Scenario: The broker cannot sign without its key
    Given the broker cannot read the signing key
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the broker answers not ok with the code "signing_key_unavailable"

  @broker
  Scenario Outline: The supervisor role reaches its computer's snapshot prefix and nothing else
    Given the supervisor role of organization "anthus" on computer "computer-1"
    When the supervisor requests "<action>" on the "<store>" for the key "<key>"
    Then the supervisor role <verdict> the request

    Examples:
      | action                     | store     | key                                  | verdict |
      | s3:GetObject               | snapshots | tenants/anthus/computers/computer-1/snapshot.tar.gz | allows  |
      | s3:PutObject               | snapshots | tenants/anthus/computers/computer-1/manifest.json   | allows  |
      | s3:AbortMultipartUpload    | snapshots | tenants/anthus/computers/computer-1/snapshot.tar.gz | allows  |
      | s3:DeleteObject            | snapshots | tenants/anthus/computers/computer-1/snapshot.tar.gz | denies  |
      | s3:ListBucket              | snapshots | tenants/anthus/computers/computer-1/                | denies  |
      | s3:GetObject               | snapshots | tenants/anthus/computers/computer-2/snapshot.tar.gz | denies  |
      | s3:GetObject               | snapshots | tenants/other/computers/computer-1/snapshot.tar.gz  | denies  |
      | s3:GetObject               | sessions  | conversations/anthus%23bot-1%23channel-1/log        | denies  |
      | dynamodb:GetItem           | messaging | anthus#turn#0000000004                              | denies  |
      | dynamodb:PutItem           | messaging | anthus#computer#record                              | denies  |
      | dynamodb:GetItem           | messaging | anthus#org                                          | denies  |
      | dynamodb:Query             | conversations | PI#anthus#bot-1#channel-1                       | denies  |

  @broker
  Scenario Outline: A per-turn credential reaches its own conversation and not the snapshot or another channel
    Given the owner role of bot "bot-1" in channel "channel-1" of organization "anthus" on computer "computer-1" in turn "turn-1"
    When the owner requests "<action>" on the "<store>" for the key "<key>"
    Then the owner role <verdict> the request

    Examples:
      | action           | store     | key                                                  | verdict |
      | s3:GetObject     | sessions  | conversations/anthus%23bot-1%23channel-1/log         | allows  |
      | s3:GetObject     | sessions  | conversations/anthus%23bot-1%23channel-2/log         | denies  |
      | s3:GetObject     | snapshots | tenants/anthus/computers/computer-1/snapshot.tar.gz  | denies  |
      | s3:PutObject     | snapshots | tenants/anthus/computers/computer-1/manifest.json    | denies  |
      | dynamodb:GetItem | conversations | PI#anthus#bot-1#channel-1                        | allows  |
      | dynamodb:GetItem | conversations | PI#anthus#bot-1#channel-2                        | denies  |

  @supervisor
  Scenario: An owner with a bootstrap token and a snapshot hydrates, becomes idle and holds nothing in its environment
    Given a supervisor whose task environment holds a bootstrap token
    When the supervisor starts
    Then it exchanges the bootstrap token once and removes it from its environment
    And it polls in state "hydrating" while it hydrates the snapshot
    And it reports the computer running and the model and workspace gates ready with its supervisor token
    And it polls in state "idle" once the workspace is ready
    And the supervisor's environment holds no AWS access key, secret key or session token

  @supervisor
  Scenario: A bootstrap the control plane refuses ends the owner
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane answers the bootstrap with 409 "bootstrap_already_used"
    When the supervisor starts
    Then it exits with code 6 and logs "owner_bootstrap_failed"
    And it started no child and published nothing

  @supervisor
  Scenario: A bootstrap that cannot reach the control plane is retried inside the token's life
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane answers the bootstrap with 503 "credentials_unavailable" twice and then succeeds
    When the supervisor starts
    Then it polls in state "idle" after the third attempt

  @supervisor
  Scenario: A dispatch starts a child that holds the turn's credentials and nothing of the supervisor's
    Given an idle supervisor
    When the control plane offers a dispatch for turn "turn-1" of bot "bot-1"
    Then the supervisor starts one child with the subcommand "turn"
    And the child's environment holds exactly the names in the child list
    And the child's environment holds the dispatch's gateway token and the dispatch's AWS credentials
    And the child's environment holds none of the bootstrap token, the supervisor token, the Front Door address, the snapshot bucket, the live root, the invoke key, the old host token or a model key
    And the supervisor's next poll is in state "serving" with the turn and the dispatch id
    And it logged "owner_dispatch_received" and "owner_serving_turn"

  @supervisor
  Scenario: A dispatch for a turn the supervisor already serves is ignored
    Given a supervisor serving turn "turn-1" under dispatch "d-1"
    When the control plane offers dispatch "d-2" for turn "turn-1"
    Then the supervisor starts no second child

  @supervisor
  Scenario: A child that exits cleanly returns the supervisor to idle at once
    Given a supervisor serving turn "turn-1"
    When the child exits with code 0
    Then the supervisor kills every process of the unprivileged user
    And it logs "owner_child_exited" with clean "true"
    And it polls immediately in state "idle"
    And its idle clock restarts

  @supervisor
  Scenario: A child that lost the claim race is not a failure
    Given a supervisor serving turn "turn-1"
    When the child exits with code 1
    Then the supervisor counts no failure

  @supervisor
  Scenario: Three children in a row that fail make the owner stop as unhealthy
    Given an idle supervisor
    When three children in a row exit with code 70
    Then the supervisor asks to stop with reason "unhealthy"
    And after the approval it reports the computer stopped and exits with code 0

  @supervisor
  Scenario: A process the model left running does not survive its turn
    Given a supervisor serving turn "turn-1" while an unprivileged process "sleeper" runs
    When the child exits with code 0
    Then process "sleeper" is killed
    And no process of the root user is killed

  @supervisor
  Scenario: Idle timeout publishes and stops
    Given an idle supervisor that changed the workspace in its last turn
    When 900 seconds pass without a dispatch
    Then the supervisor asks to stop with reason "idle"
    And after the approval it reports state "stopping"
    And it publishes the snapshot
    And it reports the computer stopped for its generation
    And it exits with code 0
    And the log has "owner_stopping" with reason "idle" and "snapshot_published"

  @supervisor
  Scenario: A stop that is vetoed is not asked for again for thirty seconds
    Given an idle supervisor
    And the control plane vetoes a stop with "work_pending"
    When 900 seconds pass without a dispatch
    Then the supervisor asks to stop with reason "idle" once
    And it logs "owner_stop_vetoed" with reason "work_pending"
    When 29 seconds pass
    Then it has not asked again
    When 2 more seconds pass
    Then it asks again

  @supervisor
  Scenario: A dispatch that arrives with the veto is served and the idle clock starts over
    Given an idle supervisor
    And the control plane vetoes a stop with "work_pending" and offers a dispatch on the next poll
    When 900 seconds pass without a dispatch
    And the supervisor polls
    Then the supervisor starts one child
    And the idle clock restarts when that child exits

  @supervisor
  Scenario: An owner told to drain finishes its turn and stops
    Given a supervisor serving turn "turn-1"
    When the control plane answers a poll with drain and reason "lifetime"
    Then the supervisor reports state "draining" and accepts no dispatch
    When the child exits with code 0
    Then the supervisor asks to stop with reason "lifetime"
    And after the approval it publishes if changed, reports the computer stopped and exits with code 0

  @supervisor
  Scenario: A drain gives the turn five minutes and then ends it
    Given a supervisor serving turn "turn-1" whose child ignores signals until killed
    When the control plane answers a poll with drain and reason "lifetime"
    And 300 seconds pass
    Then the supervisor sends the child SIGTERM
    And after 10 more seconds it sends SIGKILL
    And it asks to stop with reason "lifetime" with no active turn

  @supervisor
  Scenario: Quiet publish runs between turns and only when the disk changed
    Given an idle supervisor that changed the workspace in its last turn
    When 30 seconds pass after the child exited
    Then the supervisor polls in state "publishing" and publishes the snapshot
    And it returns to state "idle"
    When 600 seconds pass with no change to the workspace
    Then it logs "snapshot_skipped" with reason "unchanged" and reports no state change

  @supervisor
  Scenario: A publish never runs while a child runs
    Given a supervisor serving turn "turn-1" with a changed workspace
    When 600 seconds pass
    Then the supervisor has not published
    When the child exits with code 0
    Then the publish is due within 30 seconds

  @supervisor
  Scenario: An owner that cannot reach the control plane fences itself before the control plane counts it dead
    Given a supervisor serving turn "turn-1"
    And every poll fails
    When 25 seconds pass
    Then the supervisor kills the child
    And it publishes nothing
    And it logs "owner_stopping" with reason "fenced"
    And it exits with code 4

  @supervisor
  Scenario: An owner that is told it is no longer the owner stops without publishing
    Given a supervisor serving turn "turn-1"
    When the control plane answers a poll with 403 "not_current_owner"
    Then the supervisor kills the child and publishes nothing
    And it logs "owner_stopping" with reason "superseded"
    And it exits with code 5

  @supervisor
  Scenario: A poll that fails is repeated with the same sequence number
    Given an idle supervisor
    When a poll with sequence 7 times out
    Then the next poll carries sequence 7
    And after it is answered the following poll carries sequence 8

  @supervisor
  Scenario: SIGTERM stops the child, publishes and reports stopped
    Given a supervisor serving turn "turn-1" with a changed workspace
    When the supervisor receives SIGTERM
    Then it stops the child with SIGTERM and then SIGKILL after 5 seconds
    And it publishes the snapshot
    And it reports the computer stopped for its generation
    And it exits with code 143
    And the log has "owner_stopping" with reason "sigterm"

  @supervisor
  Scenario: The supervisor logs carry no token, key or credential
    Given a supervisor that has served one turn and stopped for being idle
    Then no log line contains the bootstrap token, the supervisor token, the gateway token or any AWS key

  @supervisor
  Scenario: The watchdog ends a supervisor whose main loop stopped
    Given a watchdog watching a supervisor whose liveness file is 181 seconds old
    When the watchdog checks
    Then it kills the supervisor with SIGKILL and logs "owner_watchdog_fired" with action "kill" and reason "stale"

  @supervisor
  Scenario: The watchdog asks, then forces, at the end of the lifetime
    Given a watchdog watching a supervisor that is still running
    When 3300 seconds have passed
    Then it sends SIGTERM once
    When 3420 seconds have passed
    Then it sends SIGKILL
    And it exits when the supervisor is gone
