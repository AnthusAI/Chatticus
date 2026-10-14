Feature: A long-lived computer owner renews its credentials in place and is replaced after at most eight hours
  As an operator of an organization's computer
  I want the owner to renew its credentials before they expire, and the control plane to refuse the renewal the moment the owner is not the owner any more
  So that one owner can serve a working day without restarting, a stolen credential is useful for an hour and not for the day, and no owner outlives what it is allowed to hold

  DRAFT. The @server scenarios of the renewal route moved to
  computer_owner_credential_renewal_route.feature (part A2) and the drain's to
  computer_owner_credential_drain.feature (part A1); the broker's fault switch
  and the infrastructure assertions moved to
  owner_credential_broker_fault_switch.feature (part B2). The rest of this file is
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

  # ------------------------------------------------------------ supervisor

  @supervisor
  Scenario: A turn that is not the one being served gets nothing over the socket
    Given a supervisor whose task environment holds a bootstrap token
    And a child is serving a turn that never ends on its own
    When the supervisor starts
    And the control plane dispatches the turn
    And a process asks the socket for the credentials of another dispatch
    Then the socket answers "no_turn"

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
