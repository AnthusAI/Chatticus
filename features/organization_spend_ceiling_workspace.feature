Feature: Organization spend ceiling in the workspace

  Background:
    Given an empty organization records store

  Scenario: An owner raises the ceiling through the product
    Given an enabled organization with a monthly spend ceiling
    When its owner sets a higher ceiling
    Then the organization carries the new ceiling

  Scenario: A member who is not an owner cannot change the ceiling through the product
    Given an enabled organization with a monthly spend ceiling
    When a member who is not an owner attempts to change it
    Then the change is refused
    And the ceiling is unchanged

  Scenario Outline: A ceiling that is not a positive amount is refused
    Given an enabled organization with a monthly spend ceiling
    When its owner submits a ceiling of "<amount>"
    Then the change is rejected as invalid
    And the ceiling is unchanged

    Examples:
      | amount |
      | 0      |
      | -5     |
      | lots   |

  Scenario: The owner's workspace data carries the role and the ceiling
    Given an enabled organization with a monthly spend ceiling
    When the owner opens the workspace
    Then the workspace data says the signed-in user is an owner
    And the workspace data shows the ceiling 250.00

  Scenario: A member's workspace data carries the role but not the ceiling
    Given an enabled organization with a monthly spend ceiling
    And the organization has a channel with a readable message
    When a member opens the workspace
    Then the workspace data says the signed-in user is a member
    And the workspace data does not show the ceiling

  Scenario: The workplace stays reachable past the ceiling
    Given an enabled organization whose month-to-date spend has passed its ceiling
    And the organization has a channel with a readable message
    When a member opens the workspace
    Then they read their channels and see why work is paused
    And the organization status is still enabled

  Scenario: The workplace shows meter unavailable pause
    Given an enabled organization with a monthly spend ceiling
    And month-to-date spend rollup for today is pending
    And the organization has a channel with a readable message
    When a member opens the workspace
    Then they see computer work paused for meter unavailability
    And the organization status is still enabled
