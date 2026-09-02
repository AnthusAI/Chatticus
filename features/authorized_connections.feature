Feature: Authorized connections between organizations
  As an organization member
  I want connections between organizations to clip to my ceiling
  So that another organization may reach only the resources my standing allows

  A connection between organizations is a clip: it authorizes members of one
  organization to act with borrowed standing on a named resource in another
  organization, bounded by the proposing member's ceiling and clipped again by
  what the granting organization permits to leave.

  Background:
    Given an empty control plane
    And organization "Anthus Labs" with tenant "anthus" has enabled members:
      | email            |
      | ryan@example.com |
      | sam@example.com  |
    And organization "Partner Co" with tenant "partner" also has enabled members:
      | email            |
      | alex@example.com |
    And organization "Anthus Labs" has shared channel "support-queue"
    And organization "Anthus Labs" has shared channel "legal-review"
    And organization "Anthus Labs" has shared channel "executive-briefing"

  Scenario: A member proposes a connection within their authority ceiling
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "connection" with:
      | channel          | support-queue |
      | receiving_tenant | partner       |
    When "sam@example.com" proposes a connection for organization "Partner Co" to read shared channel "support-queue" in organization "Anthus Labs"
    Then the connection is authorized and clipped to "sam@example.com" ceiling

  Scenario: A member is refused when proposing a connection outside their authority ceiling
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "connection" with:
      | channel          | support-queue |
      | receiving_tenant | partner       |
    When "sam@example.com" tries to propose a connection for organization "Partner Co" to read shared channel "legal-review" in organization "Anthus Labs"
    Then proposing a connection outside the member authority ceiling is refused

  Scenario: A connection proposal exceeding the requester's ceiling routes to the nearest member whose ceiling covers it
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "connection" with:
      | channel          | support-queue |
      | receiving_tenant | partner       |
    And organization "Anthus Labs" member "ryan@example.com" has authority ceiling for structured "connection" with:
      | channel          | legal-review |
      | receiving_tenant | partner      |
    When "sam@example.com" proposes a connection for organization "Partner Co" to read shared channel "legal-review" in organization "Anthus Labs"
    And the connection proposal is routed for approval
    Then the connection proposal escalates to "ryan@example.com"

  Scenario: A connection proposal exceeding every member ceiling stays blocked
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "connection" with:
      | channel          | support-queue |
      | receiving_tenant | partner       |
    And organization "Anthus Labs" member "ryan@example.com" has authority ceiling for structured "connection" with:
      | channel          | legal-review |
      | receiving_tenant | partner      |
    When "sam@example.com" proposes a connection for organization "Partner Co" to read shared channel "executive-briefing" in organization "Anthus Labs"
    And the connection proposal is routed for approval
    Then no organization member ceiling covers the connection
    And the connection proposal stays blocked until a member with sufficient standing approves it
