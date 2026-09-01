Feature: Browser capability containment
  As a household member
  I want untrusted pages contained even when they manipulate the model
  So that reading the web cannot grant new access

  Background:
    Given an empty control plane

  Scenario: A page asks the model to exceed a research task
    Given a task grants read-only browsing on approved origins
    And grants no workspace upload, messaging, or external recipient
    When a page instructs the model to exfiltrate workspace data
    And the model requests the forbidden operation
    Then the worker denies the request
    And no data reaches an unapproved origin or tool
    And the denial is recorded for the user

  Scenario: Research browsing is separate from a privileged session
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And a human task grants:
      | field          | value                         |
      | tools          | browse                        |
      | origins        | https://untrusted.example     |
      | recipients     |                               |
      | file_scopes    |                               |
      | egress_classes | approved_origin_fetch           |
    And the household computer holds a privileged authenticated session
    When the bot opens an untrusted research page
    Then that browsing context cannot use the privileged session or its secrets
