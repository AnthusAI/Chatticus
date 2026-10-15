Feature: Principal kinds
  As a Chatticus operator
  I want a typed principal
  So that every caller is a user or a worker and nothing else

  Scenario: A principal carries user or worker kind only
    Given a user principal for tenant "tenant-1"
    Then that principal has kind "user"
    And a worker principal for tenant "tenant-1" has kind "worker"
