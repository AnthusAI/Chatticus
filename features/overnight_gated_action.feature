Feature: Overnight gated action
  As a household member
  I want a routine that reaches a consequential action with my laptop closed
  to stop honestly or run only against a pre-authorized control
  So that approvals are never silently bypassed and work is never silently lost

  Scenario: A consequential action is reached with no watcher
    Given an empty control plane
    And the laptop is closed and no human is at a screen
    When the unattended turn reaches structured action "send" with:
      | recipient | alex@example.com |
      | body      | hello            |
    Then the action is not executed
    And the turn is blocked waiting for a human
    When a bot tries to add an always-allow rule for "send"
    Then the kernel refuses the bot-initiated auto-review loosening
    And a later unattended "send" with those arguments is still not executed

  Scenario: A pre-authorized rule allows an unattended consequential action
    Given an empty control plane
    And a human created an always-allow rule for structured "send" with:
      | recipient | alex@example.com |
      | body      | hello            |
    And the laptop is closed and no human is at a screen
    When the unattended turn reaches structured action "send" with:
      | recipient | alex@example.com |
      | body      | hello            |
    Then the action executes
    And completion evidence is recorded
    When the unattended turn reaches structured action "send" with:
      | recipient | other@example.com |
      | body      | hello             |
    Then the action is not executed
    And the turn is blocked waiting for a human

  Scenario: A generic browser action cannot be pre-authorized overnight
    Given an empty control plane
    And a human created an always-allow rule for structured "purchase" with:
      | destination | store.example |
      | amount      | 12.00         |
    And the laptop is closed and no human is at a screen
    When the unattended turn reaches browser action "purchase" with:
      | destination | store.example |
      | amount      | 12.00         |
    Then the action is not executed
    And the turn reports that user-controlled completion is required
    And the routine does not retry the action unattended
