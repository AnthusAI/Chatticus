Feature: Shared organization channels and teammates
  As an organization member
  I want channels, bots, and workspace files shared across teammates
  So that we collaborate on one conversation surface instead of owner-only silos

  Background:
    Given an empty control plane
    And organization "Anthus Labs" with tenant "anthus" has enabled members:
      | email            |
      | ryan@example.com |
      | sam@example.com  |

  Scenario: Two organization members read and post in one shared channel
    Given organization "Anthus Labs" has shared channel "general"
    When "ryan@example.com" posts "hello from ryan" in shared channel "general"
    And "sam@example.com" posts "hello from sam" in shared channel "general"
    Then "ryan@example.com" can read 2 messages in shared channel "general"
    And "sam@example.com" can read 2 messages in shared channel "general"
    And the shared channel message with seq 1 has body "hello from ryan"
    And the shared channel message with seq 2 has body "hello from sam"

  Scenario: A bot named once in an organization is the same teammate to every member
    When "ryan@example.com" creates organization bot "Researcher"
    Then "sam@example.com" lists organization bot "Researcher"
    And organization bot "Researcher" belongs to organization "Anthus Labs"
    And "sam@example.com" cannot create a second organization bot named "Researcher"

  Scenario: A file one organization bot saves is continued by another bot and by a person
    Given organization "Anthus Labs" has organization bots:
      | Researcher |
      | Writer     |
    And organization "Anthus Labs" has shared channel "handoff" with organization bots:
      | Researcher |
      | Writer     |
    When organization bot "Researcher" writes "accounts.md" containing "top ten accounts" on the organization computer
    And organization bot "Researcher" posts "wrote /workspace/accounts.md" addressed to organization bot "Writer" in shared channel "handoff"
    Then organization bot "Writer" can read "accounts.md" as "top ten accounts" from the organization computer
    And "sam@example.com" can continue file "accounts.md" on the organization computer
