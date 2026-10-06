Feature: Organization spend ceiling

  Background:
    Given an empty organization records store

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

  Scenario: A turn that waits on the browser is refused past the ceiling
    Given an enabled organization whose month-to-date spend has passed its ceiling
    And the organization computer is stopped
    When a member asks a bot to open the household browser
    Then the request is refused with a spend ceiling reason
    And the turn is completed rather than left waiting
    And no computer is started

  Scenario: Raising the ceiling through the product resumes work
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

  Scenario: New computer work is refused while the spend meter could not be read
    Given an enabled organization with a monthly spend ceiling
    And month-to-date spend rollup for today could not be read
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

  Scenario: A computer continuation is refused at host start while paused
    Given an enabled organization with a monthly spend ceiling
    And a queued computer continuation for workspace file read
    And month-to-date spend has passed the ceiling
    When a computer-capable worker pulls the paused spend continuation job
    Then the request is refused with a spend ceiling reason
    And no computer is started
    And the computer continuation job is removed from the queue
