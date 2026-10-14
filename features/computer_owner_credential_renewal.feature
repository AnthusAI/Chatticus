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

  # ---------------------------------------------------------- supervisor, child
  #
  # The supervisor's socket and the per-turn child's providers are told in
  # computer_owner_credential_renewal_child.feature, which is registered. The
  # structural half of "The child holds no AWS client without explicit
  # credentials" (no client built without credentials, no reference to the
  # container credentials endpoint or the instance metadata service) is a guard
  # in conversation/test/computer-image-structure.test.ts.

  # ----------------------------------------------------------------- image
  #
  # The only scenario here that cucumber-js cannot run: it needs the built
  # image. computer/test_owner_container.sh runs it against the image CI builds
  # for every image build.

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
