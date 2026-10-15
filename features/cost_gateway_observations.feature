Feature: The gateway keeps what it saw of every call it forwarded, and a call the session never committed is still counted once
  As the operator of an organization computer
  I want the model gateway to keep an observation of each answered call
  So that a call the vendor billed and the session never committed is not lost

  The session's cost records are the cost of a turn. They cover every call the
  session committed. A call the vendor answered but the session never committed
  (the container died between the answer and its commit) exists nowhere in the
  session, so the gateway is the only witness. It keeps one observation per call,
  keyed by the vendor's response id (or its own request id when it never saw
  one), with the usage the vendor reported, or an estimate flagged as such when
  the stream was interrupted. Observations are evidence: they expire after 35
  days and they are never written to the ledger by the gateway. Reconciliation
  (see cost_gateway_reconciliation.feature) turns an observation into cost only
  when no session record accounts for the same call.

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a channel with a named bot "Helper"
    And bot "Helper" has an active turn owned by a container owner
    And the vendor answers "Good morning." using 120 input tokens and 30 output tokens
    And the default vendor prices of the production compositions are in force

  Scenario: An answered call is kept as an observation named by the vendor's response id
    Given the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    Then the only observation of the turn names the vendor's response id, has 120 input and 30 output tokens and is not an estimate
    And the observation of the turn expires within 35 days
    And the vendor ledger holds no spend for the turn

  Scenario: An answer the container abandons midway is kept as an estimated observation
    Given the container holds a session token for its turn valid for 300 seconds
    And the vendor holds its answer back after the first text delta
    When the container asks the model gateway for an answer and reads only the start
    And the container drops the connection
    Then the gateway comes to keep 1 estimated observation for the turn
    And the vendor ledger holds no spend for the turn

  Scenario: A call the vendor answered and the session never committed is counted once from its observation
    Given the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    And the container's turn has completed
    And 10800 seconds pass
    And the gateway observations of the organization are reconciled
    Then the organization holds 1 gateway-sourced cost row with 120 input and 30 output tokens costing 0.000018 dollars
    And each gateway-sourced cost row also has a cost index item flagged as a gateway call
    When the gateway observations of the organization are reconciled again
    Then the organization holds 1 gateway-sourced cost row with 120 input and 30 output tokens costing 0.000018 dollars

  Scenario: An interrupted call the session never committed is counted from its estimate and says so
    Given the container holds a session token for its turn valid for 300 seconds
    And the vendor holds its answer back after the first text delta
    When the container asks the model gateway for an answer and reads only the start
    And the container drops the connection
    Then the gateway comes to keep 1 estimated observation for the turn
    When the container's turn has completed
    And 10800 seconds pass
    And the gateway observations of the organization are reconciled
    Then the organization holds 1 gateway-sourced cost row
    And each gateway-sourced cost row also has a cost index item flagged as a gateway call
