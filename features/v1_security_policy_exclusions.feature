Feature: v1 security policy exclusions
  As a household member
  I want Chatticus to name the attacks it cannot yet enforce against
  So that a missing control is not mistaken for a shipped boundary

  Background:
    Given an empty control plane

  Scenario Outline: v1 records exclusions that have no enforceable control
    When a reviewer asks whether the kernel enforces "<exclusion>"
    Then the policy records "<exclusion>" as a v1 exclusion
    And no worker claims that control is enforced

    Examples:
      | exclusion                         |
      | snapshot_cookie_integrity         |
      | bot_to_bot_channel_injection      |
      | approval_fatigue                  |
      | prompt_data_separation_as_boundary|
      | generic_browser_click_binding     |
      | local_device_execution_isolation  |
      | bot_as_security_boundary          |

  Scenario: Prompt and data separation is a mitigation, not a boundary
    When a page injects instructions the model follows
    Then sink denial is the enforceable control
    And the policy does not treat prompt wording as the security boundary

  Scenario: Generic browser clicks have no exact-operation binding in v1
    Given no structured connector or takeover control can bind the exact operation
    When the model attempts to send through an authenticated browser
    Then the required binding control is "unbound_stop"
    And the policy records "generic_browser_click_binding" as a v1 exclusion
