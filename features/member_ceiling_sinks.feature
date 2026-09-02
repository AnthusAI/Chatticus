Feature: Member authority ceiling at capability sinks
  As an organization member
  I want my standing ceiling enforced where operations actually execute
  So that a generous task grant cannot bypass what my role allows

  Background:
    Given an empty control plane
    And organization "Anthus Labs" with tenant "anthus" has enabled members:
      | email            |
      | ryan@example.com |
      | sam@example.com  |
    And tenant "anthus" member "sam@example.com" has a bot named "Researcher"

  Scenario: A member whose ceiling excludes purchase is denied at the sink through the model tool loop
    Given a human task grants:
      | field          | value                              |
      | tools          | browse, read_workspace, purchase   |
      | origins        | https://store.example.com          |
      | recipients     |                                    |
      | file_scopes    | /workspace/research                |
      | egress_classes | approved_origin_fetch, file_transfer |
    And turn "ceiling-sink-turn" carries the capability grant
    When member "sam@example.com" asks bot "Researcher" to "purchase item SKU-42 from store.example.com"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn journal records a denied purchase tool result
    And the member authority ceiling denial is recorded for the turn
    And the denied tool result does not leak session secrets

  Scenario: A member is denied at the send sink when the recipient exceeds their standing ceiling
    Given organization "Anthus Labs" member "sam@example.com" has authority ceiling for structured "send" with:
      | recipient | alex@example.com |
      | body      | weekly update    |
    And a human task grants:
      | field          | value           |
      | tools          | send            |
      | origins        |                 |
      | recipients     | evil@example.com |
      | file_scopes    |                 |
      | egress_classes | structured_send |
    And turn "ceiling-sink-turn" carries the capability grant
    When member "sam@example.com" asks bot "Researcher" to "send evil@example.com the weekly update"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn journal records a denied send tool result
    And the member authority ceiling denial is recorded for the turn
    And the denied tool result does not leak session secrets
