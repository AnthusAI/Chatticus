Feature: Organization spend ceiling

  Background:
    Given an empty organization records store

  Scenario: Provisioning records a monthly ceiling
    Given an organization being provisioned into a customer AWS account
    When provisioning completes
    Then the organization carries a monthly AWS spend ceiling

  Scenario: An owner raises the ceiling
    Given an enabled organization with a monthly spend ceiling
    When its owner sets a higher ceiling
    Then the organization carries the new ceiling

  Scenario: A member who is not an owner cannot change the ceiling
    Given an enabled organization with a monthly spend ceiling
    When a member who is not an owner attempts to change it
    Then the change is refused
    And the ceiling is unchanged

  Scenario: New computer work is refused past the ceiling
    Given an enabled organization whose month-to-date spend has passed its ceiling
    And the organization computer is stopped
    And a human task grants:
      | field          | value                              |
      | tools          | browse, read_workspace             |
      | origins        | https://docs.example.com           |
      | recipients     |                                    |
      | file_scopes    | /workspace/research                |
      | egress_classes | approved_origin_fetch, file_transfer |
    When a member asks a bot for work that needs the computer
    Then the request is refused with a spend ceiling reason
    And no computer is started

  Scenario: The workplace stays reachable past the ceiling
    Given an enabled organization whose month-to-date spend has passed its ceiling
    And the organization has a channel with a readable message
    When a member opens the workspace
    Then they read their channels and see why work is paused
    And the organization status is still enabled

  Scenario: Raising the ceiling resumes work
    Given an organization whose work is paused at its spend ceiling
    And the organization computer is stopped
    And a human task grants:
      | field          | value                              |
      | tools          | browse, read_workspace             |
      | origins        | https://docs.example.com           |
      | recipients     |                                    |
      | file_scopes    | /workspace/research                |
      | egress_classes | approved_origin_fetch, file_transfer |
    When its owner raises the ceiling above current spend
    And a member asks a bot for work that needs the computer
    Then computer work is accepted again

  Scenario: New computer work is refused while the spend meter is unavailable
    Given an enabled organization with a monthly spend ceiling
    And month-to-date spend rollup for today is pending
    And the organization computer is stopped
    And a human task grants:
      | field          | value                              |
      | tools          | browse, read_workspace             |
      | origins        | https://docs.example.com           |
      | recipients     |                                    |
      | file_scopes    | /workspace/research                |
      | egress_classes | approved_origin_fetch, file_transfer |
    When a member asks a bot for work that needs the computer
    Then the request is refused with a spend meter unavailable reason
    And no computer is started

  Scenario: The workplace shows meter unavailable pause
    Given an enabled organization with a monthly spend ceiling
    And month-to-date spend rollup for today is pending
    And the organization has a channel with a readable message
    When a member opens the workspace
    Then they see computer work paused for meter unavailability
    And the organization status is still enabled

  Scenario: A computer continuation is refused at host start while paused
    Given an enabled organization with a monthly spend ceiling
    And a queued computer continuation for workspace file read
    And month-to-date spend has passed the ceiling
    When a computer-capable worker pulls the paused spend continuation job
    Then the request is refused with a spend ceiling reason
    And no computer is started
    And the computer continuation job is removed from the queue
