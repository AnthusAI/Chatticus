Feature: The control plane serves the long-lived computer owner: bootstrap, poll, dispatch, stop and start check
  As the operator of an organization computer
  I want the owner of the computer to exchange one token for its credentials, ask for work and ask to stop
  So that a container can stay up between turns, serve the next turn without a start, and switch itself off only when nothing is pending

  The routes and records the supervisor in the container talks to. The starter
  puts one bootstrap token in the task; the owner exchanges it once on
  POST /host/owner/bootstrap for a supervisor token and supervisor credentials.
  Its poll on POST /host/owner/poll is its heartbeat and the only way a turn
  reaches it: the control plane offers one dispatch at a time, with a gateway
  token and credentials for that one conversation. A stop is a request the
  control plane approves only when nothing is pending, and a start job that
  finds a live owner is acknowledged and dropped. The contract is
  docs/OWNER_SUPERVISOR_PROTOCOL.md and the wire schemas are in
  host-protocol/src/supervisor.ts. The container side is told in
  computer_owner_long_lived.feature and the starter in computer_owner_start.feature.

  Background:
    Given an empty control plane
    And the organization is homed in the deployment account
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Analyst"
    And a fake owner credential broker

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

  Scenario: A bootstrap for an owner the starter never registered is refused
    Given the starter has started an owner for generation 1 but registered no worker
    When the owner presents its bootstrap token on the bootstrap route
    Then the answer is 403 with the code "owner_not_registered"
    And the computer records no owner

  Scenario: A bootstrap that the broker cannot serve does not burn the token
    Given the starter has started an owner for generation 1
    And the broker is unavailable
    When the owner presents its bootstrap token on the bootstrap route
    Then the answer is 503 with the code "credentials_unavailable"
    When the broker is available again
    And the owner presents its bootstrap token on the bootstrap route
    Then the answer is 200

  Scenario: The control plane keeps a record of how long the owner ran, for the spend meter
    Given a bootstrapped owner of the household computer
    Then the control plane records that the owner of generation 1 ran for 0 seconds
    When the clock moves 600 seconds
    And the owner polls in state "idle" with sequence 9
    Then the control plane records that the owner of generation 1 ran for 600 seconds
    When the clock moves 5 seconds
    And the owner polls in state "serving" with sequence 8
    Then the answer is 409 with the code "stale_poll"
    And the control plane records that the owner of generation 1 ran for 600 seconds

  Scenario: The poll is the heartbeat
    Given a bootstrapped owner of the household computer
    When the clock moves 20 seconds
    And the owner polls in state "idle"
    Then the owner is the live owner of the computer
    When the clock moves 31 seconds
    Then the owner is not the live owner of the computer
    And a turn that parks on the computer publishes a start job

  Scenario: A poll whose answer was lost is answered with the same dispatch
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the owner polls in state "idle" with sequence 4
    Then the poll offered one dispatch with attempt 1
    When the owner repeats the poll with sequence 4
    Then the poll offered the same dispatch id with attempt 1
    And the broker issued turn credentials twice for the one dispatch

  Scenario: A dispatch that was never claimed is offered again under a new id
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the owner polls in state "idle" with sequence 4
    And the clock moves 31 seconds
    And the owner polls in state "idle" with sequence 5
    Then the poll offered one dispatch with attempt 2
    And the dispatch id differs from the first

  Scenario: A claimed dispatch is not offered again
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And the model is scripted to answer "Saved."
    When the owner polls in state "idle" with sequence 4
    And computer owner "owner-child" takes over the turn and is held after its tool ran
    And the owner polls in state "idle" with sequence 5
    Then the poll offered no dispatch
    When held computer owner "owner-child" is released
    Then the takeover of "owner-child" ended "done"

  Scenario: Only one dispatch is outstanding and none is offered while the owner serves
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And a turn of bot "Analyst" parked on a workspace action
    When the owner polls in state "idle" with sequence 4
    Then the poll offered one dispatch for the turn of bot "Researcher"
    When the owner polls in state "serving" with the dispatched turn and sequence 5
    Then the poll offered no dispatch

  Scenario: A dispatch carries the credentials of one conversation and no host token
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the owner polls in state "idle" with sequence 4
    Then the dispatch names the turn, bot, channel, member and action
    And the broker was asked for turn credentials with the five tags: tenant, bot, channel, computer and turn
    And the dispatch holds a gateway token bound to the turn and the owner id
    And the dispatch holds no host token

  Scenario: A parked action of an organization over its spend ceiling is denied and not delivered
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And the organization sets a monthly AWS spend ceiling of "0.01" dollars and has spent more
    When the owner polls in state "idle" with sequence 4
    Then the poll offered no dispatch
    And the action of the turn was answered as denied
    And the turn was resumed

  Scenario: A broker that cannot issue turn credentials leaves the owner healthy and the turn parked
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And the broker is unavailable
    When the owner polls in state "idle" with sequence 4
    Then the poll offered no dispatch
    And the owner is the live owner of the computer
    When the broker is available again
    And the owner polls in state "idle" with sequence 5
    Then the poll offered one dispatch with attempt 1

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

  Scenario: A poll that arrives out of order is refused
    Given a bootstrapped owner of the household computer
    When the owner polls in state "idle" with sequence 9
    And the owner polls in state "serving" with sequence 8
    Then the answer is 409 with the code "stale_poll"
    And the owner's recorded state is still "idle"

  Scenario: A poll that does not match the schema or the token is refused with a code
    Given a bootstrapped owner of the household computer
    When the owner polls in state "serving" with no active turn and sequence 4
    Then the answer is 422 with the code "invalid_request"
    When the owner polls as owner "owner-someone-else" in state "idle" with sequence 5
    Then the answer is 403 with the code "credential_mismatch"

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

  Scenario Outline: A token that does not belong to this owner, organization or moment is refused
    Given a bootstrapped owner of the household computer
    When the owner polls with a supervisor token that is <fault>
    Then the answer is <status> with the code "<code>"

    Examples:
      | fault                                      | status | code               |
      | expired                                    | 401    | invalid_credential |
      | signed with another key                    | 401    | invalid_credential |
      | a model gateway token                      | 401    | invalid_credential |
      | a bootstrap token                          | 401    | invalid_credential |
      | signed without the start time of the owner | 401    | invalid_credential |
      | for another organization                   | 403    | wrong_organization |
      | for another owner id                       | 403    | not_current_owner  |
      | for a computer that is not this one        | 403    | not_current_owner  |

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

  Scenario: The owner routes cannot be opened with the invoke key alone
    Given a bootstrapped owner of the household computer
    When a caller with the invoke key and no token calls "POST /owner/poll"
    Then the answer is 403 with the code "not_current_owner"

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

  Scenario: A stop with nothing pending is approved and the computer stops accepting dispatches
    Given a bootstrapped owner of the household computer
    When the owner asks to stop with reason "idle"
    Then the stop was approved
    When a turn of bot "Researcher" parks on a workspace action
    And the owner polls in state "stopping" with sequence 5
    Then the poll offered no dispatch
    And no computer start job is queued

  Scenario: A parked action of a finished turn does not veto a stop
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" that failed while its workspace action was still requested
    When the owner asks to stop with reason "idle"
    Then the stop was approved

  Scenario: An approved stop and a dispatch cannot both win
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the control plane judges a stop request and a poll for the same owner at the same moment
    Then exactly one of these holds
      | the stop was approved and the poll offered no dispatch |
      | the stop was vetoed and the poll offered one dispatch  |

  Scenario: A stop for the lifetime is refused before the owner is told to drain and approved after
    Given a bootstrapped owner of the household computer
    When the owner asks to stop with reason "lifetime"
    Then the stop was not approved and the reason is "not_draining"
    When the clock has moved 3000 seconds past the owner's bootstrap
    And a turn of bot "Researcher" parked on a workspace action
    And the owner asks to stop with reason "lifetime"
    Then the stop was approved

  Scenario: The control plane drains an owner whose credentials end in ten minutes whatever is parked
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the clock has moved 3000 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 4
    Then the poll answered drain with reason "credentials" and no dispatch

  Scenario: An owner that is failing is allowed to stop whatever is pending
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the owner asks to stop with reason "unhealthy"
    Then the stop was approved

  Scenario: A stale start job is acknowledged as already serving
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And a recording host start driver
    And the start lease of the owner's generation has expired
    When a start job for the turn is delivered to the starter
    Then the start ended "already_serving" for the owner and generation 1
    And the host start driver was not invoked
    And the computer is still on host start generation 1

  Scenario: An owner that is still hydrating counts as the owner
    Given a bootstrapped owner of the household computer that has not finished hydrating
    And a published snapshot newer than the hydrated one
    And a turn of bot "Researcher" parked on a workspace action
    And a recording host start driver
    When a start job for the turn is delivered to the starter
    Then the start ended "already_serving" for the owner and generation 1

  Scenario: An owner whose heartbeat lapsed no longer counts and the start goes ahead
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And a recording host start driver
    When the clock moves 31 seconds
    And a start job for the turn is delivered to the starter
    Then the start ended "started" for generation 2
    And the host start driver was invoked once

  Scenario: A customer-account host worker is unaffected by the owner check
    Given host worker "customer-host" serves the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And a recording host start driver
    When the clock moves 31 seconds
    And a start job for the turn is delivered to the starter
    Then the start ended "started" for generation 1

  Scenario: The stopped report ends the owner and can be repeated
    Given a bootstrapped owner of the household computer
    When the owner reports the computer stopped for generation 1
    Then the computer is stopped and records no owner and no dispatch
    And the computer still records generation 1 as the last owner generation
    When the owner reports the computer stopped for generation 1 again
    Then the answer is 200
    When the owner polls in state "idle" with sequence 9
    Then the answer is 403 with the code "not_current_owner"

  Scenario: The owner reports the computer stopped only for the generation it was started for
    Given a bootstrapped owner of the household computer
    When the owner reports the computer stopped for generation 2
    Then the answer is 403 with the code "stale_generation"
    When the owner reports the computer stopped without naming a generation
    Then the answer is 403 with the code "stale_generation"
    And the computer still has the start lease of generation 1
    When the owner reports the computer stopped for generation 1
    Then the answer is 200
    And the host start lease of generation 1 has ended

  Scenario: The stopped report starts the next owner for a turn that parked behind the stopping owner
    Given a bootstrapped owner of the household computer
    And the owner asks to stop with reason "idle"
    And a turn of bot "Researcher" parked on a workspace action
    And no computer start job is queued
    When the owner reports the computer stopped for generation 1
    Then a computer start job is queued for the turn

  Scenario: An owner that was replaced cannot publish over the newer owner's snapshot
    Given a bootstrapped owner of the household computer
    And the owner reports the computer stopped for generation 1
    And a second owner is bootstrapped for generation 2
    When the first owner reports a published snapshot
    Then the answer is 403 with the code "stale_generation"
    And the computer's snapshot is unchanged
