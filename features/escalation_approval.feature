Feature: Approval escalation when standing is insufficient
  As an organization member
  I want consequential operations above my ceiling to route to a member who can approve
  So that work does not stall while someone with standing can complete it from the web tab

  v1 has no completable approval path while nobody is at a screen; presence is
  guaranteed only for interactive review in the web tab. In an organization,
  presence is a team property: human_takeover and immutable_approval may be
  satisfied by any member with sufficient standing.

  Background:
    Given an empty control plane
    And organization "Anthus Labs" with tenant "anthus" has enabled members:
      | email            |
      | ryan@example.com |
      | sam@example.com  |

  @wip
  Scenario: An action exceeding the requester's ceiling routes to the nearest member whose ceiling covers it
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
