Feature: The organization computer stays on between turns and switches itself off when nobody needs it
  As a household member
  I want the computer to keep running after a turn and answer my next message in seconds
  So that I do not wait for a cold start every time, and the computer still costs nothing while nobody works

  DRAFT. The steps of these scenarios do not exist yet; the implementers write them
  with their parts and add this file to features/cucumber-features.txt in the same
  change. The contract is docs/OWNER_SUPERVISOR_PROTOCOL.md and the wire schemas are
  in host-protocol/src/supervisor.ts. Tags name who writes the steps. The tag
  "server" covers the routes, the stores and the start check; the credential
  broker has its own feature, owner_credential_broker.feature; "supervisor" the program in the container,
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
