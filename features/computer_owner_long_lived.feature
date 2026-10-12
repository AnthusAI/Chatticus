Feature: The organization computer stays on between turns and switches itself off when nobody needs it
  As a household member
  I want the computer to keep running after a turn and answer my next message in seconds
  So that I do not wait for a cold start every time, and the computer still costs nothing while nobody works

  DRAFT. The steps of these scenarios do not exist yet; the implementers write them
  with their parts and add this file to features/cucumber-features.txt in the same
  change. The contract is docs/OWNER_SUPERVISOR_PROTOCOL.md and the wire schemas are
  in host-protocol/src/supervisor.ts. Tags name who writes the steps. The tag
  "server" covers the routes, the stores and the start check; "broker" the
  credential broker and the roles; "end-to-end" the real routes with the real
  supervisor loop. The "supervisor" scenarios, the program in the container with a
  fake Front Door, clock and process table, are written and live in
  features/computer_owner_supervisor.feature.

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

  @server
  Scenario: The owner exchanges its bootstrap token once
    Given the starter has started an owner for generation 1
    When the owner presents its bootstrap token on the bootstrap route
    Then the answer is 200
    And the answer holds a supervisor token valid for 3600 seconds and supervisor credentials
    And the supervisor token names the organization, the computer, the owner and generation 1 and no turn
    And the computer records the owner, generation 1, a start time and no dispatch
    When the same bootstrap token is presented again
    Then the answer is 409 with the code "bootstrap_already_used"
    And the broker was asked for supervisor credentials twice and the second answer was discarded

  @server
  Scenario Outline: A bootstrap token that is not good is refused
    Given the starter has started an owner for generation 1
    When the owner presents a bootstrap token that is <fault>
    Then the answer is <status> with the code "<code>"
    And the computer records no owner

    Examples:
      | fault                                     | status | code                |
      | expired                                   | 401    | invalid_credential  |
      | signed with another key                   | 401    | invalid_credential  |
      | a gateway token                           | 401    | invalid_credential  |
      | a supervisor token                        | 401    | invalid_credential  |
      | for another organization                  | 403    | wrong_organization  |
      | for generation 2 while generation 1 runs  | 403    | stale_generation    |
      | for an owner id other than the request's  | 403    | credential_mismatch |

  @server
  Scenario: A bootstrap that the broker cannot serve does not burn the token
    Given the starter has started an owner for generation 1
    And the broker is unavailable
    When the owner presents its bootstrap token on the bootstrap route
    Then the answer is 503 with the code "credentials_unavailable"
    When the broker is available again
    And the owner presents its bootstrap token on the bootstrap route
    Then the answer is 200

  @server
  Scenario: The poll is the heartbeat
    Given a bootstrapped owner of the household computer
    When the clock moves 20 seconds
    And the owner polls in state "idle"
    Then the owner is the live owner of the computer
    When the clock moves 31 seconds
    Then the owner is not the live owner of the computer
    And a turn that parks on the computer publishes a start job

  @server
  Scenario: A poll whose answer was lost is answered with the same dispatch
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the owner polls in state "idle" with sequence 4
    Then the poll offered one dispatch with attempt 1
    When the owner repeats the poll with sequence 4
    Then the poll offered the same dispatch id with attempt 1
    And the broker issued turn credentials twice for the one dispatch

  @server
  Scenario: A dispatch that was never claimed is offered again under a new id
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the owner polls in state "idle" with sequence 4
    And the clock moves 31 seconds
    And the owner polls in state "idle" with sequence 5
    Then the poll offered one dispatch with attempt 2
    And the dispatch id differs from the first

  @server
  Scenario: A claimed dispatch is not offered again
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the owner polls in state "idle" with sequence 4
    And computer owner "owner-child" takes over the turn
    And the owner polls in state "idle" with sequence 5
    Then the poll offered no dispatch

  @server
  Scenario: Only one dispatch is outstanding and none is offered while the owner serves
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And a turn of bot "Analyst" parked on a workspace action
    When the owner polls in state "idle" with sequence 4
    Then the poll offered one dispatch for the turn of bot "Researcher"
    When the owner polls in state "serving" with the dispatched turn and sequence 5
    Then the poll offered no dispatch

  @server
  Scenario: A dispatch carries the credentials of one conversation and no host token
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the owner polls in state "idle" with sequence 4
    Then the dispatch names the turn, bot, channel, member and action
    And the broker was asked for turn credentials with the five tags: tenant, bot, channel, computer and turn
    And the dispatch holds a gateway token bound to the turn and the owner id
    And the dispatch holds no host token

  @server
  Scenario: A parked action of an organization over its spend ceiling is denied and not delivered
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And the organization sets a monthly AWS spend ceiling of "0.01" dollars and has spent more
    When the owner polls in state "idle" with sequence 4
    Then the poll offered no dispatch
    And the action of the turn was answered as denied
    And the turn was resumed

  @server
  Scenario Outline: The control plane tells the owner how soon to ask again
    Given a bootstrapped owner of the household computer
    When the owner polls in state "<state>" with sequence <sequence>
    And the owner has been idle for <idle> seconds
    And the owner polls again in state "<state>" with sequence <next>
    Then the poll asked the owner to poll again in <milliseconds> milliseconds

    Examples:
      | state      | sequence | idle | next | milliseconds |
      | idle       | 4        | 10   | 5    | 1000         |
      | idle       | 4        | 120  | 5    | 3000         |
      | idle       | 4        | 400  | 5    | 10000        |
      | hydrating  | 4        | 0    | 5    | 2000         |
      | publishing | 4        | 0    | 5    | 2000         |
      | serving    | 4        | 0    | 5    | 5000         |

  @server
  Scenario: A poll that arrives out of order is refused
    Given a bootstrapped owner of the household computer
    When the owner polls in state "idle" with sequence 9
    And the owner polls in state "serving" with sequence 8
    Then the answer is 409 with the code "stale_poll"
    And the owner's recorded state is still "idle"

  @server
  Scenario Outline: An owner of an older generation is refused on every owner route
    Given a bootstrapped owner of the household computer
    And a newer host start generation has been claimed
    When the owner calls "<route>"
    Then the answer is 403 with the code "stale_generation"

    Examples:
      | route                          |
      | POST /owner/poll               |
      | POST /owner/stop-request       |
      | GET /computer                  |
      | POST /computer/state           |
      | POST /snapshot/published       |
      | POST /snapshot/hydrated        |

  @server
  Scenario Outline: A token that does not belong to this owner, organization or moment is refused
    Given a bootstrapped owner of the household computer
    When the owner polls with a supervisor token that is <fault>
    Then the answer is <status> with the code "<code>"

    Examples:
      | fault                                   | status | code               |
      | expired                                 | 401    | invalid_credential |
      | signed with another key                 | 401    | invalid_credential |
      | a model gateway token                   | 401    | invalid_credential |
      | a bootstrap token                       | 401    | invalid_credential |
      | for another organization                | 403    | wrong_organization |
      | for another owner id                    | 403    | not_current_owner  |
      | for a computer that is not this one     | 403    | not_current_owner  |

  @server
  Scenario Outline: The supervisor token is refused on every route the supervisor does not call
    Given a bootstrapped owner of the household computer
    When the owner calls "<route>" with its supervisor token
    Then the answer is 401 or 403

    Examples:
      | route                                        |
      | POST /heartbeat                              |
      | POST /actions/claim                          |
      | POST /actions/a1/result                      |
      | POST /workers/register                       |
      | POST /model-gateway/v1/responses             |
      | GET /users/ryan/computer                     |

  @server
  Scenario: The owner routes cannot be opened with the invoke key alone
    Given a bootstrapped owner of the household computer
    When a caller with the invoke key and no token calls "POST /owner/poll"
    Then the answer is 403 with the code "not_current_owner"

  @server
  Scenario Outline: A stop is vetoed by pending work
    Given a bootstrapped owner of the household computer
    And <situation>
    When the owner asks to stop with reason "idle"
    Then the stop was not approved and the reason is "<veto>"

    Examples:
      | situation                                                                    | veto             |
      | a turn of bot "Researcher" parked on a workspace action                      | work_pending     |
      | a dispatch offered for a parked turn of bot "Researcher"                     | dispatch_pending |
      | a turn that the owner claimed whose lease has not run out                    | turn_active      |

  @server
  Scenario: A stop with nothing pending is approved and the computer stops accepting dispatches
    Given a bootstrapped owner of the household computer
    When the owner asks to stop with reason "idle"
    Then the stop was approved
    When a turn of bot "Researcher" parks on a workspace action
    And the owner polls in state "stopping" with sequence 5
    Then the poll offered no dispatch
    And no computer start job is queued

  @server
  Scenario: A parked action of a finished turn does not veto a stop
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" that failed while its workspace action was still requested
    When the owner asks to stop with reason "idle"
    Then the stop was approved

  @server
  Scenario: An approved stop and a dispatch cannot both win
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the control plane judges a stop request and a poll for the same owner at the same moment
    Then exactly one of these holds
      | the stop was approved and the poll offered no dispatch |
      | the stop was vetoed and the poll offered one dispatch  |

  @server
  Scenario: A stop for the lifetime is refused before the owner is told to drain and approved after
    Given a bootstrapped owner of the household computer
    When the owner asks to stop with reason "lifetime"
    Then the stop was not approved and the reason is "not_draining"
    When the clock has moved 3000 seconds past the owner's bootstrap
    And a turn of bot "Researcher" parked on a workspace action
    And the owner asks to stop with reason "lifetime"
    Then the stop was approved

  @server
  Scenario: The control plane drains an owner at its maximum lifetime
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the clock has moved 3000 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 4
    Then the poll answered drain with reason "lifetime" and no dispatch

  @server
  Scenario: An owner that is failing is allowed to stop whatever is pending
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the owner asks to stop with reason "unhealthy"
    Then the stop was approved

  @server
  Scenario: A stale start job is acknowledged as already serving
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And a recording host start driver
    And the start lease of the owner's generation has expired
    When a start job for the turn is delivered to the starter
    Then the start ended "already_serving" for the owner and generation 1
    And the host start driver was not invoked
    And the computer is still on host start generation 1

  @server
  Scenario: An owner that is still hydrating counts as the owner
    Given a bootstrapped owner of the household computer that has not finished hydrating
    And a published snapshot newer than the hydrated one
    And a turn of bot "Researcher" parked on a workspace action
    And a recording host start driver
    When a start job for the turn is delivered to the starter
    Then the start ended "already_serving" for the owner and generation 1

  @server
  Scenario: An owner whose heartbeat lapsed no longer counts and the start goes ahead
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And a recording host start driver
    When the clock moves 31 seconds
    And a start job for the turn is delivered to the starter
    Then the start ended "started" for generation 2
    And the host start driver was invoked once

  @server
  Scenario: A customer-account host worker is unaffected by the owner check
    Given host worker "customer-host" serves the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And a recording host start driver
    When the clock moves 31 seconds
    And a start job for the turn is delivered to the starter
    Then the start ended "started" for generation 1

  @server
  Scenario: The stopped report ends the owner and can be repeated
    Given a bootstrapped owner of the household computer
    When the owner reports the computer stopped for generation 1
    Then the computer is stopped and records no owner and no dispatch
    And the computer still records generation 1 as the last owner generation
    When the owner reports the computer stopped for generation 1 again
    Then the answer is 200
    When the owner polls in state "idle" with sequence 9
    Then the answer is 403 with the code "not_current_owner"

  @server
  Scenario: An owner that was replaced cannot publish over the newer owner's snapshot
    Given a bootstrapped owner of the household computer
    And the owner reports the computer stopped for generation 1
    And a second owner is bootstrapped for generation 2
    When the first owner reports a published snapshot
    Then the answer is 403 with the code "stale_generation"
    And the computer's snapshot is unchanged

  @server
  Scenario: The starter holds no role and puts one secret in the task
    When the starter handles a start job for a computer in the deployment account
    Then STS was not asked to assume any role
    And the task command is "node /opt/chatticus/host/supervisor.mjs"
    And the container environment names no turn, no bot, no gateway token, no host token and no AWS credential
    And the container environment holds exactly one secret: a bootstrap token valid for 300 seconds
    And the bootstrap token names the organization, the computer, the new owner id and the claimed generation
    And the starter registered the owner as a worker of the household computer

  @server
  Scenario: An identifier that cannot be a session tag value stops the start before a task runs
    Given the computer of the organization has the identifier "has space"
    When the starter handles a start job for a computer in the deployment account
    Then the start was refused mentioning "computer"
    And the starter ran exactly 0 ECS tasks

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
