Feature: Per-worker credentials
  As the Chatticus control plane
  I want each worker to present a minted bearer credential
  So that chunk POSTs are authenticated without mistaking the invoke key for identity

  Scenario: Worker registration mints a token once
    Given an empty control plane
    When a worker registers over HTTP:
      | worker_id    | garage-mac-1 |
      | tenant_id    | anthus       |
      | cost_class   | local        |
      | capabilities | cpu          |
    Then the registration response includes a worker token
    And tenant "anthus" has 1 healthy worker

  Scenario: Re-registering rotates the worker token
    Given an empty control plane
    And a worker registered over HTTP as:
      | worker_id    | garage-mac-1 |
      | tenant_id    | anthus       |
      | cost_class   | local        |
      | capabilities | cpu          |
    When a worker registers over HTTP:
      | worker_id    | garage-mac-1 |
      | tenant_id    | anthus       |
      | cost_class   | fargate      |
      | capabilities | cpu          |
    Then the registration response includes a new worker token
    And the previous worker token is rejected on worker routes

  Scenario: A worker claims and completes a turn with its credential
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Helper"
    And a worker registered over HTTP as:
      | worker_id    | turn-worker |
      | tenant_id    | anthus      |
      | cost_class   | local       |
      | capabilities | cpu         |
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Helper" on the channel
    And the worker claims the turn over HTTP
    And the worker posts chunk "done" completing the turn over HTTP
    Then the latest bot message body equals the joined chunks for the active turn

  Scenario: Worker routes reject a missing bearer credential
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Helper"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Helper" on the channel
    And a worker route is called without a bearer credential
    Then the worker route responds with status 403

  Scenario: Worker routes reject the invoke key without a bearer credential
    Given an empty control plane with invoke key "edge-secret"
    And tenant "anthus" user "ryan" has a channel with a named bot "Helper"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Helper" on the channel
    And a worker route is called with only the invoke key
    Then the worker route responds with status 403

  Scenario: Browser routes reject a worker bearer credential
    Given an empty control plane
    And a worker registered over HTTP as:
      | worker_id    | garage-mac-1 |
      | tenant_id    | anthus       |
      | cost_class   | local        |
      | capabilities | cpu          |
    When the worker bearer credential is used on a browser route
    Then the browser route responds with status 403

  Scenario: Worker routes reject a user principal
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Helper"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Helper" on the channel
    And a user principal calls a worker route
    Then the worker route responds with status 403

  Scenario: A worker credential still authenticates after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And a worker registered over HTTP as:
      | worker_id    | garage-mac-1 |
      | tenant_id    | anthus       |
      | cost_class   | local        |
      | capabilities | cpu          |
    When a recycled Front Door serves the same messaging store
    And the worker bearer credential is used on a worker route
    Then the worker route responds with status 200
