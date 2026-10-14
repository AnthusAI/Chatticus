Feature: A long-lived computer owner renews its credentials in place and is replaced after at most eight hours
  As an operator of an organization's computer
  I want the owner to renew its credentials before they expire, and the control plane to refuse the renewal the moment the owner is not the owner any more
  So that one owner can serve a working day without restarting, a stolen credential is useful for an hour and not for the day, and no owner outlives what it is allowed to hold

  DRAFT. The @server scenarios of the renewal route moved to
  computer_owner_credential_renewal_route.feature (part A2) and the drain's to
  computer_owner_credential_drain.feature (part A1). The rest of this file is
  the Phase 2b contract's behavior and is not in
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

  # ---------------------------------------------------------------- broker

  @broker
  Scenario: The broker renews supervisor credentials with the role and tags of the bootstrap
    Given the broker holds the signing key
    When the broker is asked for supervisor renewal credentials with a valid supervisor token
    Then the role "ComputerSupervisorRole" was assumed for 3600 seconds
    And the session tags are exactly "tenant" and "computer"
    And the broker's assume-role call carries no session policy
    And the session name is the session name of the bootstrap
    And the answer holds a supervisor token that keeps the bootstrap time of the token it was given
    And the credentials, the token and the token's expiry end at the same moment

  @broker
  Scenario Outline: The broker refuses what it should not renew
    Given the broker holds the signing key
    When the broker is asked for supervisor renewal credentials and <fault>
    Then the broker answers not ok with the code "<code>"
    And STS was not asked to assume a role

    Examples:
      | fault                                                              | code                   |
      | the authorization is a bootstrap token                             | invalid_authorization  |
      | the authorization is a model gateway token                         | invalid_authorization  |
      | the authorization is an expired supervisor token                   | invalid_authorization  |
      | the authorization names another owner than the payload             | authorization_mismatch |
      | the authorization names another computer than the payload         | authorization_mismatch |
      | the authorization is a supervisor token without a start time       | invalid_authorization  |
      | the owner was bootstrapped 27900 seconds ago                       | owner_lifetime_over    |
      | the owner was bootstrapped 30000 seconds ago                       | owner_lifetime_over    |
      | the payload names a turn                                           | invalid_request        |

  @broker
  Scenario: No credential the broker issues outlives the hard lifetime
    Given the broker holds the signing key
    And the owner was bootstrapped 26000 seconds ago
    When the broker is asked for supervisor renewal credentials with a valid supervisor token
    Then the role was assumed for 2800 seconds
    And the credentials, the token and the token's expiry end 28800 seconds after the bootstrap
    When the broker is asked for turn credentials with a valid supervisor token
    Then the role was assumed for 2800 seconds
    And the gateway token and the credentials end 28800 seconds after the bootstrap

  @broker
  Scenario: A renewal reports an STS failure by name only
    Given the broker holds the signing key
    And STS refuses the assume-role call with the error "AccessDenied"
    When the broker is asked for supervisor renewal credentials with a valid supervisor token
    Then the broker answers not ok with the code "assume_role_failed"
    And the message is "AccessDenied" and holds no token, key or credential

  @broker
  Scenario: A turn is refused for a supervisor token without a start time
    Given the broker holds the signing key
    When the broker is asked for turn credentials with a supervisor token without a start time
    Then the broker answers not ok with the code "invalid_authorization"
    And STS was not asked to assume a role

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

  @broker
  Scenario: A supervisor token issued at bootstrap names the moment the owner started
    Given the broker holds the signing key
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the answer holds a supervisor token whose bootstrap time is the time of the broker's clock

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
