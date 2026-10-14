Feature: A long-lived computer owner renews its credentials in place and is replaced after at most eight hours
  As an operator of an organization's computer
  I want the owner to renew its credentials before they expire, and the control plane to refuse the renewal the moment the owner is not the owner any more
  So that one owner can serve a working day without restarting, a stolen credential is useful for an hour and not for the day, and no owner outlives what it is allowed to hold

  DRAFT. This file is the Phase 2b contract's behavior and is not in
  features/cucumber-features.txt. Each part of docs/OWNER_CREDENTIAL_RENEWAL.md
  section 15 moves the scenarios it owns into the real run together with their
  steps. Tags: @server (the routes and records), @broker (the credential
  broker), @supervisor (the container supervisor against a fake Front Door),
  @child (the per-turn child and the local socket), @image (the built
  container), @infra (CDK assertions), @end-to-end (real routes, real
  supervisor, fake clock). The contract is docs/OWNER_CREDENTIAL_RENEWAL.md;
  the Phase 2a behavior it builds on is told in owner_supervisor_server.feature,
  owner_credential_broker.feature, computer_owner_supervisor.feature and
  computer_owner_long_lived.feature.

  An owner holds two sets of credentials. The supervisor holds AWS credentials
  for the computer's snapshot prefix and a supervisor token; each lasts at most
  one hour, and the supervisor asks for the next set when twenty minutes are
  left. The turn it serves holds AWS credentials for one conversation and a model
  gateway token; the supervisor renews those the same way and the child reads
  them over a local socket. The control plane decides whether a renewal is
  allowed and when the owner must drain: when the credentials it issued would
  expire within ten minutes, or at seven hours and fifty minutes, whichever
  comes first.

  Background:
    Given an empty control plane
    And the organization is homed in the deployment account
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Analyst"
    And a fake owner credential broker

  # ---------------------------------------------------------------- server

  @server
  Scenario: The owner renews its supervisor credentials and keeps its generation
    Given a bootstrapped owner of the household computer
    When the clock has moved 2400 seconds past the owner's bootstrap
    And the owner asks for new supervisor credentials
    Then the answer is 200
    And the answer holds a supervisor token valid for 3600 seconds, a new set of supervisor credentials and no turn
    And the supervisor token keeps the owner's bootstrap time and names the same organization, computer, owner and generation
    And the broker was asked for supervisor renewal credentials with the owner's current supervisor token as the authorization
    And the computer records the new expiry of the owner's credentials
    And the computer still records the same owner and generation 1
    And the previous supervisor token still opens the poll route until it expires

  @server
  Scenario Outline: A renewal that is not good is refused
    Given a bootstrapped owner of the household computer
    When the owner asks for new supervisor credentials with a token that is <fault>
    Then the answer is <status> with the code "<code>"
    And the broker was not asked for renewal credentials

    Examples:
      | fault                                        | status | code                |
      | expired                                      | 401    | invalid_credential  |
      | signed with another key                      | 401    | invalid_credential  |
      | a bootstrap token                            | 401    | invalid_credential  |
      | a model gateway token                        | 401    | invalid_credential  |
      | for another organization                     | 403    | wrong_organization  |
      | for generation 2 while generation 1 runs     | 403    | stale_generation    |
      | an owner that a newer owner replaced         | 403    | not_current_owner   |

  @server
  Scenario: A renewal that names another owner than its token is refused
    Given a bootstrapped owner of the household computer
    When the owner asks for new supervisor credentials naming another owner id
    Then the answer is 403 with the code "credential_mismatch"
    And the broker was not asked for renewal credentials

  @server
  Scenario: A renewal is refused after the computer stopped
    Given a bootstrapped owner of the household computer
    And the owner reported the computer stopped
    When the owner asks for new supervisor credentials
    Then the answer is 403 with the code "not_current_owner"
    And the broker was not asked for renewal credentials

  @server
  Scenario: The credentials route is not part of the stopped report replay
    Given a bootstrapped owner of the household computer
    And the owner reported the computer stopped
    When the owner repeats the stopped report
    Then the answer is 200
    When the owner asks for new supervisor credentials
    Then the answer is 403 with the code "not_current_owner"

  @server
  Scenario: A renewal is refused once a stop was approved
    Given a bootstrapped owner of the household computer
    And the owner asks to stop with reason "unhealthy"
    And the stop was approved
    When the owner asks for new supervisor credentials
    Then the answer is 409 with the code "owner_stopping"
    And the broker was not asked for renewal credentials

  @server
  Scenario Outline: A renewal is refused once the control plane drains the owner
    Given a bootstrapped owner of the household computer
    And the control plane drains the owner because of <cause>
    When the owner asks for new supervisor credentials
    Then the answer is 409 with the code "owner_draining"
    And the broker was not asked for renewal credentials

    Examples:
      | cause                                                 |
      | credentials that would expire within 600 seconds      |
      | the lifetime of 28200 seconds                         |
      | a protocol version below the minimum                  |

  @server
  Scenario: No renewal is granted in the last 900 seconds of the hard lifetime
    Given a bootstrapped owner of the household computer whose credentials were renewed until 28800 seconds after its bootstrap
    When the clock has moved 27900 seconds past the owner's bootstrap
    And the owner asks for new supervisor credentials
    Then the answer is 409 with the code "owner_draining"
    And the broker was not asked for renewal credentials

  @server
  Scenario: Renewals are limited to one a minute for each kind
    Given a bootstrapped owner of the household computer
    When the owner asks for new supervisor credentials
    And the owner asks for new supervisor credentials again 30 seconds later
    Then the second answer is 429 with the code "renewal_too_soon"
    And the broker was asked for renewal credentials once
    When 31 more seconds go by
    And the owner asks for new supervisor credentials
    Then the answer is 200

  @server
  Scenario: A renewal the broker cannot serve changes nothing and may be asked again at once
    Given a bootstrapped owner of the household computer
    And the broker cannot issue credentials
    When the owner asks for new supervisor credentials
    Then the answer is 503 with the code "credentials_unavailable"
    And the computer still records the expiry of the credentials from the bootstrap
    When the broker can issue credentials again
    And the owner asks for new supervisor credentials
    Then the answer is 200

  @server
  Scenario: A renewal that lost the race with an approved stop is discarded unseen
    Given a bootstrapped owner of the household computer
    And the broker holds its answer until released
    When the owner asks for new supervisor credentials
    And the owner asks to stop with reason "unhealthy" and the stop is approved
    And the broker releases its answer
    Then the renewal answer is 409 with the code "owner_stopping"
    And the computer records the expiry of the credentials from the bootstrap

  @server
  Scenario: The owner renews the credentials of the turn it serves
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" in channel "general" was dispatched to the owner and claimed
    When the clock has moved 2400 seconds past the dispatch
    And the owner asks for new credentials for the dispatched turn
    Then the answer is 200
    And the answer holds a model gateway token bound to the turn, the bot and the owner id
    And the answer holds credentials for a session tagged with the tenant, the bot, the channel, the computer and the turn
    And the broker was asked for turn credentials with the owner's supervisor token as the authorization

  @server
  Scenario Outline: Turn credentials are refused for a turn the owner is not serving
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" in channel "general" was dispatched to the owner and claimed
    When the owner asks for new credentials for <request>
    Then the answer is 409 with the code "turn_not_served"
    And the broker was not asked for turn credentials

    Examples:
      | request                                             |
      | a dispatch id that was never offered                |
      | a turn id other than the dispatched turn            |
      | the dispatched turn after it completed              |
      | the dispatched turn after another owner claimed it  |

  @server
  Scenario: Turn credentials are renewed while the owner drains but not after a stop is approved
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" in channel "general" was dispatched to the owner and claimed
    And the control plane drains the owner because of credentials that would expire within 600 seconds
    When the owner asks for new credentials for the dispatched turn
    Then the answer is 200
    When the owner asks to stop with reason "lifetime" and the stop is approved
    And 61 seconds go by
    And the owner asks for new credentials for the dispatched turn
    Then the answer is 409 with the code "owner_stopping"

  @server
  Scenario: Turn credentials and supervisor credentials are limited separately
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" in channel "general" was dispatched to the owner and claimed
    When the owner asks for new supervisor credentials
    And the owner asks for new credentials for the dispatched turn
    Then both answers are 200
    When the owner asks for new credentials for the dispatched turn again 30 seconds later
    Then the answer is 429 with the code "renewal_too_soon"

  @server
  Scenario: A new dispatch starts the turn credential limit over
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" in channel "general" was dispatched to the owner and claimed
    And the owner asked for new credentials for the dispatched turn
    When a turn of bot "Analyst" in channel "general" is dispatched to the owner and claimed 10 seconds later
    And the owner asks for new credentials for that dispatch
    Then the answer is 200

  @server
  Scenario: The credentials route cannot be opened with the invoke key alone
    Given a bootstrapped owner of the household computer
    When a caller with the invoke key and no owner token asks for new supervisor credentials
    Then the answer is 403 with the code "not_current_owner"
    And the broker was not asked for renewal credentials

  @server
  Scenario: A renewal does not count as work
    Given a bootstrapped owner of the household computer
    And the owner polled in state "idle" and the computer records when it became idle
    When the owner asks for new supervisor credentials
    Then the computer still records the same idle start
    And no dispatch, stop approval or file operation was recorded

  # ---------------------------------------------------------------- broker

  @broker
  Scenario: The development fault switch denies a renewal and shortens the credentials
    Given the broker holds the signing key
    And the broker runs in the environment "development" with the fault "deny_supervisor_renewal"
    When the broker is asked for supervisor renewal credentials with a valid supervisor token
    Then the broker answers not ok with the code "assume_role_failed"
    Given the broker runs in the environment "development" with credentials limited to 900 seconds
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the role "ComputerSupervisorRole" was assumed for 900 seconds
    When the broker runs in the environment "development" with credentials limited to 7200 seconds
    Then the broker refuses to start

  @broker
  Scenario Outline: The broker refuses to start with a fault switch outside development
    Given the broker holds the signing key
    When the broker is started in the environment <environment> with the fault "deny_supervisor_renewal"
    Then the broker refuses to start
    And every invocation of the deployed entry point fails
    And STS was not asked to assume a role

    Examples:
      | environment  |
      | "production" |
      | "staging"    |
      | ""           |
      | not set      |

  # ------------------------------------------------------------ supervisor

  @supervisor
  Scenario: The supervisor renews its credentials twenty minutes before they expire
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane issues credentials that last 3600 seconds
    When the supervisor starts
    And 2399 seconds go by
    Then the supervisor has asked for new supervisor credentials 0 times
    When 2 seconds go by
    Then the supervisor asked for new supervisor credentials once
    And its next request carried the new supervisor token
    And the disk was opened once and its storage requests after that carry the new credentials

  @supervisor
  Scenario: The supervisor keeps polling while a renewal is in flight
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane answers a renewal after 9 seconds
    When the supervisor starts
    And 2410 seconds go by
    Then the supervisor polled at least every 5 seconds during the renewal
    And it did not fence itself

  @supervisor
  Scenario Outline: A renewal that fails is repeated with growing pauses until it succeeds
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane answers the first 4 renewals with <failure>
    When the supervisor starts
    And 2400 seconds go by
    And 200 seconds go by
    Then the supervisor asked for new supervisor credentials 5 times, 15, 30, 60 and 60 seconds apart
    And the fifth renewal succeeded and the supervisor holds the new credentials
    And its log holds "owner_credentials_refresh_failed" four times and "owner_credentials_refreshed" once

    Examples:
      | failure                              |
      | 503 "credentials_unavailable"        |
      | 429 "renewal_too_soon"               |
      | a network error                      |
      | a body that does not parse           |

  @supervisor
  Scenario Outline: A renewal the control plane refuses for good is not repeated
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane answers every renewal with 409 "<code>"
    When the supervisor starts
    And 2500 seconds go by
    Then the supervisor asked for new supervisor credentials once
    And the supervisor goes on polling and serving with the credentials it holds

    Examples:
      | code           |
      | owner_draining |
      | owner_stopping |

  @supervisor
  Scenario Outline: A renewal that says the owner is not the owner ends it
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane answers the renewal with <status> "<code>"
    When the supervisor starts
    And 2401 seconds go by
    Then the supervisor stopped without publishing and exited with code 5
    And its log holds "owner_stopping" with the reason "superseded"

    Examples:
      | status | code               |
      | 401    | invalid_credential |
      | 403    | stale_generation   |
      | 403    | not_current_owner  |

  @supervisor
  Scenario: An owner whose renewals keep failing drains ten minutes before its credentials expire and stops before they do
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane answers every renewal with 503 "credentials_unavailable"
    And the control plane accepts a stop with reason "credentials" whatever is pending
    And the disk takes 2 seconds to publish
    And a child is serving a turn that never ends on its own
    When the supervisor starts
    And 3000 seconds go by
    Then the supervisor reported state "draining"
    And its log holds "owner_credentials_expiring" and "owner_draining"
    When 300 seconds go by
    Then the child was ended and the supervisor asked to stop with reason "credentials"
    And the disk was published and the computer reported stopped for generation 1
    And the supervisor exited with code 0 before 3420 seconds after its bootstrap

  @supervisor
  Scenario: An owner that cannot finish its stop before the credentials end exits at the hard deadline
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane answers every renewal with 503 "credentials_unavailable"
    And the disk never finishes publishing
    When the supervisor starts
    And 3571 seconds go by
    Then the supervisor exited with code 9
    And its log holds "owner_stopping" with the reason "credentials_expired"

  @supervisor
  Scenario: A publish in flight when the credentials are swapped finishes and the next request uses the new ones
    Given a supervisor whose task environment holds a bootstrap token
    And the disk takes 20 seconds to publish and records the credentials of each storage request
    And the disk holds changes to publish
    When the supervisor starts
    And 2395 seconds go by
    And the quiet publish begins and the credentials are renewed 5 seconds later
    And 30 seconds go by
    Then the publish finished without an error
    And the storage requests that began before the renewal carry the first credentials
    And the storage requests that began after it carry the renewed credentials

  @supervisor
  Scenario: The token and the credentials are swapped in one step
    Given a supervisor whose task environment holds a bootstrap token
    When the supervisor starts
    And 2401 seconds go by
    Then no request the control plane saw carried the new supervisor token while the storage client still used the old credentials
    And no request carried the old supervisor token after the first one that carried the new

  @supervisor
  Scenario: A renewal does not start the supervisor's idle clock over
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane approves an idle stop
    When the supervisor starts
    And 901 seconds go by
    Then the supervisor asked to stop with reason "idle"
    And it asked for new supervisor credentials 0 times

  @supervisor
  Scenario: The supervisor renews nothing once it is stopping
    Given a supervisor whose task environment holds a bootstrap token
    And the disk takes 2 seconds to publish
    When the supervisor starts
    And 2395 seconds go by
    And the supervisor is told to stop because the container is stopping
    And 10 seconds go by
    Then the supervisor asked for new supervisor credentials 0 times

  @supervisor
  Scenario: A live file request is answered while a renewal is in flight
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane answers a renewal after 9 seconds
    And the control plane delivers a read request in the poll at 2402 seconds
    When the supervisor starts
    And 2410 seconds go by
    Then the supervisor posted the answer to the read request within 2 seconds of receiving it

  @supervisor
  Scenario: The supervisor renews the credentials of the turn it serves and keeps them in memory
    Given a supervisor whose task environment holds a bootstrap token
    And a child is serving a turn that never ends on its own
    When the supervisor starts
    And the control plane dispatches the turn
    And 2401 seconds go by
    Then the supervisor asked for new credentials for the dispatched turn once
    And the child's environment holds no AWS access key, secret key, session token or gateway token
    When the child exits
    Then the supervisor holds no credentials for any turn

  @supervisor
  Scenario: A turn credential renewal that fails is repeated until it succeeds or the child ends
    Given a supervisor whose task environment holds a bootstrap token
    And a child is serving a turn that never ends on its own
    And the control plane answers the first 3 turn credential renewals with 503 "credentials_unavailable"
    When the supervisor starts
    And the control plane dispatches the turn
    And 2500 seconds go by
    Then the supervisor asked for new credentials for the dispatched turn 4 times
    And the socket answers the child with the renewed credentials

  @supervisor
  Scenario: A turn that is not the one being served gets nothing over the socket
    Given a supervisor whose task environment holds a bootstrap token
    And a child is serving a turn that never ends on its own
    When the supervisor starts
    And the control plane dispatches the turn
    And a process asks the socket for the credentials of another dispatch
    Then the socket answers "no_turn"

  @supervisor
  Scenario: The supervisor logs about credentials carry no token, key or credential
    Given a supervisor whose task environment holds a bootstrap token
    When the supervisor starts
    And 2401 seconds go by
    Then no log line holds the supervisor token, either set of credentials or a gateway token

  # ----------------------------------------------------------------- child

  @child
  Scenario: A child reads its credentials from the supervisor and holds none in its environment
    Given a supervisor that dispatched a turn to a child
    Then the child's environment holds the socket path and no AWS access key, secret key, session token or gateway token
    And the child's storage clients and its model gateway requests use the credentials the supervisor holds

  @child
  Scenario: A turn that runs past the first hour keeps working
    Given a supervisor that dispatched a turn to a child
    And the child runs a tool that takes 4000 seconds
    When 4000 seconds go by
    Then the turn ended "done"
    And every storage request of the child after 3600 seconds carried credentials issued after 2400 seconds
    And every model gateway request of the child after 3600 seconds carried a token issued after 2400 seconds

  @child
  Scenario: A child whose credentials could not be renewed fails closed
    Given a supervisor that dispatched a turn to a child
    And the control plane answers every turn credential renewal with 503 "credentials_unavailable"
    When 3660 seconds go by
    Then the child's next storage request failed for expired credentials
    And the child ended with a failure exit code
    And the child never used credentials from its environment or from the container's metadata service

  @child
  Scenario: The model gateway token is read for each request
    Given a supervisor that dispatched a turn to a child
    When the supervisor swaps the gateway token it holds
    And the child sends its next request to the model gateway
    Then the request carried the swapped token

  @child
  Scenario: The child holds no AWS client without explicit credentials
    Given the sources the per-turn child bundle is built from
    Then every storage client the child creates is given a credential provider
    And no code the child bundles reads the container credentials endpoint or the instance metadata service

  @image
  Scenario: The shell cannot reach the supervisor's socket or the credentials
    Given the built container image running a supervisor and a child
    When a command is run as the unprivileged shell user
    Then the command cannot list the runtime directory, open the supervisor's socket or read the environment of the supervisor or the child
    And the command cannot connect to a loopback port that the supervisor holds

  # ------------------------------------------------------------ end to end

  @end-to-end
  Scenario: An owner keeps serving across a credential renewal
    Given a supervisor is running for the household computer
    And a recording host start driver
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/early.md", "content": "early"}
      """
    And the model is scripted to answer "Early saved."
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/late.md", "content": "late"}
      """
    And the model is scripted to answer "Late saved."
    When bot "Researcher" is asked "save the early file"
    And bot "Researcher" works its turn until it waits for the computer
    And the supervisor polls until it is served
    Then the turn ended "done"
    When 4000 seconds go by
    Then the supervisor renewed its supervisor credentials once
    And the owner is still the owner of generation 1
    When bot "Analyst" is asked "save the late file"
    And bot "Analyst" works its turn until it waits for the computer
    And the supervisor polls until it is served
    Then the turn ended "done"
    And the host start driver was not invoked

  @end-to-end
  Scenario: A turn longer than an hour finishes
    Given a supervisor is running for the household computer
    And the model is scripted to call "run_terminal" with:
      """
      {"command": "sleep 3900", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Done waiting."
    When bot "Researcher" is asked "wait an hour and five minutes"
    And bot "Researcher" works its turn until it waits for the computer
    And the supervisor polls until it is served
    And 3900 seconds go by
    Then the turn ended "done"
    And the supervisor renewed the turn credentials once

  @end-to-end
  Scenario: An owner that was replaced cannot renew and ends
    Given a supervisor is running for the household computer
    And a newer owner claimed generation 2 of the household computer
    When 2401 seconds go by
    Then the first supervisor stopped without publishing and exited with code 5
    And the broker was not asked for renewal credentials

  @end-to-end
  Scenario: An owner at its eight hour limit drains, stops, and the next message starts a new owner
    Given a supervisor is running for the household computer
    And a recording host start driver
    When the supervisor has renewed its credentials every 2400 seconds for 28200 seconds
    Then the supervisor reported state "draining"
    And the supervisor exited with code 0 before 28620 seconds after its bootstrap
    When bot "Researcher" is asked "save a file after the limit"
    And bot "Researcher" works its turn until it waits for the computer
    Then a computer start job is queued for the turn
    And the host start driver was invoked once

  # ----------------------------------------------------------------- infra

  @infra
  Scenario: Renewal adds no permission to the broker and no role changes its trust or session limit
    Given the synthesized control plane stack
    Then the broker's role holds the permission to read the signing key and to assume the two owner roles and nothing else
    And the supervisor role and the per-turn role still trust only the broker's role with their exact session tag keys
    And both roles keep a maximum session of 3600 seconds

  @infra
  Scenario Outline: The staging and production brokers hold no fault variable and know their environment
    Given the control plane stack synthesized for <environment>
    Then the broker's environment holds "CHATTICUS_ENVIRONMENT" set to "<environment>"
    And the broker's environment holds neither "CHATTICUS_OWNER_BROKER_FAULT" nor "CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS"

    Examples:
      | environment |
      | staging     |
      | production  |

  @infra
  Scenario Outline: The broker's development fault switch exists in development only
    Given the control plane stack synthesized for <environment> with the broker fault switch set
    Then the synthesis <outcome>

    Examples:
      | environment | outcome                         |
      | development | sets the broker's environment   |
      | staging     | fails and names the switch      |
      | production  | fails and names the switch      |
