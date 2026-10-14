Feature: The owner supervisor keeps the computer on between turns and switches it off when nobody needs it
  As an operator of an organization's computer
  I want one long-lived program in the container to ask the control plane for work, run each turn in a child that holds nothing of its own, and stop itself when it has been idle
  So that the computer answers the next message in seconds and costs nothing while nobody works

  The container starts a supervisor, not a turn. The supervisor exchanges the
  one-time bootstrap token for its own token and for credentials that reach the
  computer's snapshot prefix and nothing else, restores the disk, and then asks
  the control plane for work every second to ten seconds; that call is also its
  heartbeat. A dispatch is run in a child process whose environment is built from
  nothing but the names the child needs, so the supervisor's token and
  credentials cannot reach it. After fifteen minutes without work the supervisor
  asks to stop, and the control plane approves only if nothing is pending. The
  control plane drains an owner after fifty minutes; an owner that cannot reach
  the control plane fences itself before the control plane counts it dead.

  These scenarios drive the real supervisor against a fake Front Door plane, a
  fake clock that only moves when a step moves it, a fake process spawner and a
  fake process table. The disk is a fake that takes two seconds to publish,
  except where a scenario says it drives the real disk lifecycle. The watchdog
  scenarios run the real script with a clock file in place of the clock.

  Background:
    Given a supervisor whose task environment holds a bootstrap token

  Scenario: An owner with a bootstrap token hydrates, becomes idle and holds nothing in its environment
    Given the supervisor restores its disk through the real disk lifecycle
    And the control plane holds the report that the computer is running
    When the supervisor starts
    And 3 seconds go by
    Then it exchanged the bootstrap token once and removed it from its environment
    And its polls so far went through the states "booting, hydrating"
    When the control plane releases the held report
    And 1 seconds go by
    Then it reported the computer running and the model and workspace gates ready
    And its latest poll was in state "idle"
    And the supervisor's environment holds no AWS access key, secret key or session token

  Scenario: A bootstrap the control plane refuses ends the owner
    Given the control plane answers the bootstrap with 409 "bootstrap_already_used"
    When the supervisor starts
    Then it exits with code 6 and logs "owner_bootstrap_failed"
    And it started no child and published nothing

  Scenario: A bootstrap that cannot reach the control plane is retried inside the token's life
    Given the control plane answers the bootstrap with 503 "credentials_unavailable" twice and then succeeds
    When the supervisor starts
    And 5 seconds go by
    Then the control plane saw 3 bootstrap attempts
    And its latest poll was in state "idle"

  Scenario: A bootstrap that never succeeds ends the owner after two minutes
    Given the control plane answers every bootstrap with 503 "credentials_unavailable"
    When the supervisor starts
    And 119 seconds go by
    Then the supervisor is still running
    When 2 seconds go by
    Then it exits with code 6 and logs "owner_bootstrap_failed"

  Scenario: An owner whose disk cannot be restored publishes nothing and stops
    Given the disk cannot be restored
    When the supervisor starts
    Then it exits with code 8 and logs "snapshot_skipped" with reason "boot_failed"
    And it started no child and published nothing
    And it reported no stop

  Scenario: A dispatch starts a child that holds the supervisor's socket path and no credential of its own
    Given an idle supervisor
    When the control plane offers a dispatch for turn "turn-1" of bot "bot-1"
    Then the supervisor starts one child with the subcommand "turn"
    And the child's environment holds exactly the names in the child list
    And the child's environment holds the socket path and no AWS access key, secret key, session token or gateway token
    And the child's environment holds none of the bootstrap token, the supervisor token, the Front Door address, the snapshot bucket, the live root, the invoke key, the old host token or a model key
    And the supervisor's next poll is in state "serving" with the turn and the dispatch id
    And it logged "owner_dispatch_received" and "owner_serving_turn"

  Scenario: A dispatch for a turn the supervisor already serves is ignored
    Given a supervisor serving turn "turn-1" under dispatch "d-1"
    When the control plane offers dispatch "d-2" for turn "turn-1"
    Then the supervisor starts no second child

  Scenario: A child that exits cleanly returns the supervisor to idle at once
    Given a supervisor serving turn "turn-1"
    When the child exits with code 0
    Then the supervisor kills every process of the unprivileged user
    And it logs "owner_child_exited" with clean "true"
    And it polls immediately in state "idle"
    And its idle clock restarts

  Scenario: A child that lost the claim race is not a failure
    Given a supervisor serving turn "turn-1"
    When the child exits with code 1
    Then the supervisor counts no failure

  Scenario: Three children in a row that fail make the owner stop as unhealthy
    Given an idle supervisor
    When three children in a row exit with code 70
    Then the supervisor asks to stop with reason "unhealthy"
    And after the approval it reports the computer stopped and exits with code 0

  Scenario: A child that succeeds between failures resets the count
    Given an idle supervisor
    When two children in a row exit with code 70
    And a child exits with code 0
    And a child exits with code 70
    Then the supervisor has not asked to stop

  Scenario: A process the model left running does not survive its turn
    Given a supervisor serving turn "turn-1" while an unprivileged process "sleeper" runs
    When the child exits with code 0
    Then process "sleeper" is killed
    And no process of the root user is killed

  Scenario: Idle timeout publishes and stops
    Given an idle supervisor that changed the workspace in its last turn
    When 800 seconds go by
    And the workspace changes again
    And 100 seconds go by without a dispatch
    Then the supervisor asks to stop with reason "idle"
    When 5 seconds go by
    Then after the approval it reports state "stopping"
    And it publishes the snapshot
    And it reports the computer stopped for its generation
    And it exits with code 0
    And the log has "owner_stopping" with reason "idle" and "snapshot_published"

  Scenario: A stop that is vetoed is not asked for again for thirty seconds
    Given an idle supervisor
    And the control plane vetoes a stop with "work_pending"
    When 900 seconds go by without a dispatch
    Then the supervisor asks to stop with reason "idle" once
    And it logs "owner_stop_vetoed" with reason "work_pending"
    When 29 seconds go by
    Then it has not asked again
    When 2 more seconds go by
    Then it asks again

  Scenario: A dispatch that arrives with the veto is served and the idle clock starts over
    Given an idle supervisor
    And the control plane vetoes a stop with "work_pending" and offers a dispatch on the next poll
    When 900 seconds go by without a dispatch
    And 1 seconds go by
    Then the supervisor starts one child
    When the child exits with code 0
    Then its idle clock restarts

  Scenario: An owner told to drain finishes its turn and stops
    Given a supervisor serving turn "turn-1"
    When the control plane answers a poll with drain and reason "lifetime"
    Then the supervisor reports state "draining" and accepts no dispatch
    When the child exits with code 0
    Then the supervisor asks to stop with reason "lifetime"
    And after the approval it publishes if changed, reports the computer stopped and exits with code 0

  Scenario: An owner told to drain while idle asks to stop at once
    Given an idle supervisor
    When the control plane answers a poll with drain and reason "lifetime"
    Then the supervisor asks to stop with reason "lifetime" with no active turn
    And after the approval it publishes if changed, reports the computer stopped and exits with code 0

  Scenario: A drain gives the turn five minutes and then ends it
    Given a supervisor serving turn "turn-1" whose child ignores signals until killed
    When the control plane answers a poll with drain and reason "lifetime"
    And 300 seconds go by
    Then the supervisor sends the child SIGTERM
    When 10 seconds go by
    Then it sends the child SIGKILL
    And it asks to stop with reason "lifetime" with no active turn

  Scenario: Quiet publish runs between turns and only when the disk changed
    Given an idle supervisor that changed the workspace in its last turn
    When 30 seconds go by after the child exited
    Then the supervisor polls in state "publishing" and publishes the snapshot
    When 3 seconds go by
    Then its latest poll was in state "idle"
    When 600 seconds go by with no change to the workspace
    Then it logs "snapshot_skipped" with reason "unchanged" and reports no state change

  Scenario: A publish never runs while a child runs
    Given a supervisor serving turn "turn-1" with a changed workspace
    When 600 seconds go by
    Then the supervisor has not published
    When the child exits with code 0
    And 33 seconds go by
    Then the supervisor has published

  Scenario: A publish that fails is logged and tried again at the next trigger
    Given an idle supervisor that changed the workspace in its last turn
    And the next snapshot publish fails
    When 30 seconds go by after the child exited
    And 3 seconds go by
    Then the supervisor logged "snapshot_publish_failed" and has not published
    And its latest poll was in state "idle"
    When 610 seconds go by
    Then the supervisor has published

  Scenario: An owner that cannot reach the control plane fences itself before the control plane counts it dead
    Given a supervisor serving turn "turn-1"
    And every poll fails
    When 24 seconds go by
    Then the supervisor is still running
    When 1 seconds go by
    Then the supervisor kills the child
    And it publishes nothing
    And it logs "owner_stopping" with reason "fenced"
    And it logged "owner_poll_failed"
    And it exits with code 4

  Scenario: An owner that is told it is no longer the owner stops without publishing
    Given a supervisor serving turn "turn-1"
    When the control plane answers a poll with 403 "not_current_owner"
    Then the supervisor kills the child and publishes nothing
    And it logs "owner_stopping" with reason "superseded"
    And it exits with code 5

  Scenario Outline: A refusal that says the owner is not the owner ends it whatever the code
    Given an idle supervisor
    When the control plane answers a poll with <status> "<code>"
    Then it logs "owner_stopping" with reason "superseded"
    And it exits with code 5

    Examples:
      | status | code                |
      | 401    | invalid_credential  |
      | 403    | stale_generation    |
      | 403    | wrong_organization  |
      | 403    | credential_mismatch |

  Scenario: A poll that fails is repeated with the same sequence number
    Given an idle supervisor
    When a poll with sequence 7 times out
    And 1 seconds go by
    Then the next poll carries sequence 7
    When 1 seconds go by
    Then the following poll carries sequence 8

  Scenario: A poll the control plane calls stale is skipped past
    Given an idle supervisor
    When the control plane answers a poll with 409 "stale_poll"
    And 1 seconds go by
    Then the supervisor is still running
    And the next poll carries a sequence one higher than the refused one

  Scenario: The poll reports the memory the container uses
    Given the container uses 41 percent of its memory
    And an idle supervisor
    When 1 seconds go by
    Then its latest poll reported 41 percent of memory in use

  Scenario: The supervisor summarizes its polling once a minute
    Given an idle supervisor
    When 61 seconds go by
    Then it logged "owner_polling"

  Scenario: SIGTERM stops the child, publishes and reports stopped
    Given a supervisor serving turn "turn-1" whose child ignores signals until killed
    And the workspace has changed
    When the supervisor receives SIGTERM
    Then the supervisor sends the child SIGTERM
    When 5 seconds go by
    Then it sends the child SIGKILL
    When 3 seconds go by
    Then it publishes the snapshot
    And it reports the computer stopped for its generation
    And it exits with code 143
    And the log has "owner_stopping" with reason "sigterm"

  Scenario: An owner stops before the credentials it holds expire
    Given an idle supervisor
    And the control plane vetoes every idle stop with "work_pending"
    When 3419 seconds go by
    Then the supervisor is still running
    When 1 seconds go by
    Then the supervisor asks to stop with reason "unhealthy"
    And after the approval it reports the computer stopped and exits with code 0

  Scenario: A stopped report that fails is repeated
    Given an idle supervisor
    And the control plane refuses the stopped report twice
    When the control plane answers a poll with drain and reason "lifetime"
    And 5 seconds go by
    Then the control plane saw 3 stopped reports for generation 1
    And it exits with code 0

  Scenario: A stopped report that a newer owner refuses ends the owner as superseded
    Given an idle supervisor
    And the control plane answers the stopped report with 403 "not_current_owner"
    When the control plane answers a poll with drain and reason "lifetime"
    Then it exits with code 5

  Scenario: The supervisor logs carry no token, key or credential
    Given a supervisor that has served one turn and stopped for being idle
    Then no log line contains the bootstrap token, the supervisor token, the gateway token or any AWS key

  Scenario: The watchdog ends a supervisor whose main loop stopped
    Given a watchdog watching a supervisor whose liveness file is 181 seconds old
    When the watchdog checks
    Then it kills the supervisor with SIGKILL and logs "owner_watchdog_fired" with action "kill" and reason "stale"

  Scenario: The watchdog leaves a supervisor alone while its liveness file is fresh
    Given a watchdog watching a supervisor whose liveness file is 120 seconds old
    When the watchdog checks
    Then the watched supervisor is still running
    And the watchdog logged nothing

  Scenario: The watchdog asks, then forces, at the end of the lifetime
    Given a watchdog watching a supervisor that is still running
    When 3300 seconds have passed
    Then it sends SIGTERM once
    When 3420 seconds have passed
    Then it sends SIGKILL
    And it exits when the supervisor is gone
