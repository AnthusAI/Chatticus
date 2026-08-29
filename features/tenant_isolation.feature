Feature: Tenant isolation
  As Chatticus preparing to serve more than one household
  I want every worker and job to carry a tenant_id
  So that a worker cannot pull another tenant's turns

  Scenario: A worker only receives jobs for its tenant
    Given an empty control plane
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer     |
    When tenant "other-household" enqueues a turn:
      | capabilities | computer |
    Then the turn is not assigned

  Scenario: Two tenants can both have healthy local workers
    Given an empty control plane
    And a worker registered as:
      | worker_id   | anthus-mac |
      | tenant_id   | anthus     |
      | cost_class  | local      |
      | capabilities| computer   |
    And a worker registered as:
      | worker_id   | other-mac |
      | tenant_id   | other-household |
      | cost_class  | local      |
      | capabilities| computer   |
    When tenant "anthus" enqueues a turn:
      | capabilities | computer |
    Then the turn is assigned to worker "anthus-mac"
    When tenant "other-household" enqueues a turn:
      | capabilities | computer |
    Then the turn is assigned to worker "other-mac"
