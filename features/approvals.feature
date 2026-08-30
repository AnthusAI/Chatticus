Feature: Approvals
  As a Chatticus user
  I want consequential actions to stop for my approval
  So that a bot drafts and recommends before it sends, spends, or publishes

  Scenario: Sending requires approval by default
    Given an empty control plane
    When a bot proposes action type "send"
    Then the decision is "require_approval"

  Scenario: Publishing requires approval by default
    Given an empty control plane
    When a bot proposes action type "publish"
    Then the decision is "require_approval"

  Scenario: Purchasing requires approval by default
    Given an empty control plane
    When a bot proposes action type "purchase"
    Then the decision is "require_approval"

  Scenario: Deleting requires approval by default
    Given an empty control plane
    When a bot proposes action type "delete"
    Then the decision is "require_approval"

  Scenario: Production changes require approval by default
    Given an empty control plane
    When a bot proposes action type "production_change"
    Then the decision is "require_approval"

  Scenario: Reading a workspace file is allowed
    Given an empty control plane
    When a bot proposes action type "read_workspace"
    Then the decision is "allow"

  Scenario: Require-approval wins over always-allow
    Given an empty control plane
    And an auto-review rule always-allow for "send"
    And an auto-review rule require-approval for "send"
    When a bot proposes action type "send"
    Then the decision is "require_approval"

  Scenario: Never-allow denies the action
    Given an empty control plane
    And an auto-review rule never-allow for "purchase"
    When a bot proposes action type "purchase"
    Then the decision is "deny"

  Scenario: Never-allow wins over require-approval
    Given an empty control plane
    And an auto-review rule require-approval for "purchase"
    And an auto-review rule never-allow for "purchase"
    When a bot proposes action type "purchase"
    Then the decision is "deny"

  Scenario: Always-allow can pass a consequential action
    Given an empty control plane
    And an auto-review rule always-allow for "send"
    When a bot proposes action type "send"
    Then the decision is "allow"
