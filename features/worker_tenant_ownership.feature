Feature: Worker tenant ownership
  As Chatticus preparing to serve more than one household
  I want a worker_id to stay bound to the tenant that registered it
  So that a garage Mac cannot be stolen by re-registering under another tenant

  Scenario: Re-registering under another tenant is rejected
    Given an empty control plane
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer     |
    When a worker registers:
      | worker_id   | garage-mac-1 |
      | tenant_id   | other-household |
      | cost_class  | local        |
      | capabilities| computer     |
    Then worker registration fails because the tenant does not match
    And tenant "anthus" has 1 healthy worker
    And worker "garage-mac-1" has cost class "local"
