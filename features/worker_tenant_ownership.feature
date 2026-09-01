Feature: Worker tenant ownership
  As Chatticus preparing to serve more than one household
  I want worker_id to be scoped per tenant roster
  So that the same garage Mac name on two households is two independent workers

  Scenario: The same worker_id may register on two tenants
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
    Then tenant "anthus" has 1 healthy worker
    And tenant "other-household" has 1 healthy worker
