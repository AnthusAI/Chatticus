Feature: Exact consequential approval
  As a household member
  I want an approval to authorize exactly what I reviewed
  So that an injected model cannot substitute a different action afterward

  Scenario: Execute the reviewed structured operation
    Given an empty control plane
    And a bot proposes a structured consequential operation "send" with:
      | destination | alex@example.com |
      | payload     | hello            |
    When the user approves that operation
    And the worker executes the approved operation with target-system evidence "smtp-250"
    Then only the reviewed destination and payload may execute
    When the worker attempts to execute "send" with:
      | destination | other@example.com |
      | payload     | hello             |
    Then changing the destination requires a new approval
    When the worker attempts to execute "send" with:
      | destination | alex@example.com |
      | payload     | goodbye            |
    Then changing the payload requires a new approval
    And completion evidence identifies the target-system result
