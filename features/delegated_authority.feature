Feature: Delegated authority the way an office works
  As an organization member
  I want authority ceilings, delegations, and escalation to work like an office
  So that no one can approve, delegate, or always-allow beyond their standing

  Background:
    Given an empty control plane
    And organization "Anthus Labs" with tenant "anthus" has enabled members:
      | email            |
      | ryan@example.com |
      | sam@example.com  |

  @wip
  Scenario: A member approves a consequential operation within their authority ceiling
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "send" with:
      | recipient | alex@example.com |
      | body      | weekly update    |
    And a bot proposes a structured consequential operation "send" with:
      | destination | alex@example.com |
      | payload     | weekly update    |
    When "sam@example.com" approves that consequential operation within their ceiling
    Then the approval is granted for that exact operation
    And the operation may execute against that approval

  @wip
  Scenario: A member is refused when approving outside their authority ceiling
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "send" with:
      | recipient | alex@example.com |
      | body      | weekly update    |
    And a bot proposes a structured consequential operation "send" with:
      | destination | other@example.com |
      | payload     | weekly update     |
    When "sam@example.com" tries to approve that consequential operation within their ceiling
    Then approving outside the member authority ceiling is refused

  @wip
  Scenario: A member may write an always-allow rule within their own standing
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "send" with:
      | recipient | alex@example.com |
      | body      | weekly update    |
    When "sam@example.com" writes an always-allow rule for structured "send" with:
      | recipient | alex@example.com |
      | body      | weekly update    |
    Then the always-allow rule is recorded for organization "Anthus Labs"

  @wip
  Scenario: A member cannot write an always-allow rule broader than their standing
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "send" with:
      | recipient | alex@example.com |
      | body      | weekly update    |
    When "sam@example.com" tries to write an always-allow rule for structured "send" with:
      | recipient | anyone@example.com |
      | body      | weekly update      |
    Then writing an always-allow rule broader than the member standing is refused

  @wip
  Scenario: A covering delegation authorizes approvals while it is active
    Given organization "Anthus Labs" member "ryan@example.com" has authority ceiling for structured "send" with:
      | recipient | alex@example.com |
      | body      | weekly update    |
    And "ryan@example.com" delegates approval authority to "sam@example.com" until 7 days from now covering structured "send" with:
      | recipient | alex@example.com |
      | body      | weekly update    |
    And a bot proposes a structured consequential operation "send" with:
      | destination | alex@example.com |
      | payload     | weekly update    |
    When "sam@example.com" approves that consequential operation as delegate
    Then the approval is granted for that exact operation

  @wip
  Scenario: A covering delegation expires and no longer authorizes approvals
    Given organization "Anthus Labs" member "ryan@example.com" has authority ceiling for structured "send" with:
      | recipient | alex@example.com |
      | body      | weekly update    |
    And "ryan@example.com" delegates approval authority to "sam@example.com" until 7 days from now covering structured "send" with:
      | recipient | alex@example.com |
      | body      | weekly update    |
    And a bot proposes a structured consequential operation "send" with:
      | destination | alex@example.com |
      | payload     | weekly update    |
    When 8 days pass
    And "sam@example.com" tries to approve that consequential operation as delegate
    Then the expired delegation does not authorize the approval

  @wip
  Scenario: An action exceeding the requester ceiling escalates to a member whose ceiling covers it
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "send" with:
      | recipient | alex@example.com |
      | body      | copy edit        |
    And organization "Anthus Labs" member "ryan@example.com" has authority ceiling for structured "send" with:
      | recipient | production.example.com |
      | body      | publish                |
    And a bot on behalf of "sam@example.com" proposes structured consequential operation "send" with:
      | destination | production.example.com |
      | payload     | publish                |
    When the consequential operation is routed for approval
    Then the approval request escalates to "ryan@example.com"

  @wip
  Scenario: An action exceeding every member ceiling stays blocked for approval
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "send" with:
      | recipient | alex@example.com |
      | body      | copy edit        |
    And organization "Anthus Labs" member "ryan@example.com" has authority ceiling for structured "send" with:
      | recipient | production.example.com |
      | body      | publish                |
    And a bot on behalf of "sam@example.com" proposes structured consequential operation "send" with:
      | destination | vendor.example.com |
      | payload     | purchase order       |
    When the consequential operation is routed for approval
    Then no organization member ceiling covers the operation
    And the turn waits for a member with sufficient standing
