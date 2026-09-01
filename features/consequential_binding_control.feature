Feature: Binding controls for consequential actions
  As a household member
  I want send, publish, purchase, delete, and production change to run only
  when a control can bind the exact operation
  So that a screenshot or click coordinate is never treated as approval

  Background:
    Given an empty control plane

  Scenario Outline: Generic authenticated browser actions stop without a binding control
    Given no structured connector or takeover control can bind the exact operation
    When the model attempts to <action> through an authenticated browser
    Then the required binding control is "unbound_stop"
    And the action is not executed
    And the turn reports that user-controlled completion is required

    Examples:
      | action             |
      | send               |
      | publish            |
      | purchase           |
      | delete             |
      | change production  |

  Scenario: A structured connector plus immutable approval may execute a send
    Given a structured connector can bind action "send" with:
      | destination | alex@example.com |
      | payload     | hello            |
    When the user approves that bound operation
    And the worker executes the bound connector operation
    Then the action executes
    And completion evidence identifies the target-system result

  Scenario: A structured connector without approval does not execute
    Given a structured connector can bind action "send" with:
      | destination | alex@example.com |
      | payload     | hello            |
    When the worker executes the bound connector operation
    Then the action is not executed
    And the required binding control is "immutable_approval"

  Scenario: Human takeover may complete an authenticated browser step
    Given the human takes over the computer for an identity check
    When the model reaches an authenticated browser "purchase"
    Then the required binding control is "human_takeover"
    And the worker does not complete the purchase itself
    And the turn waits for the human to finish the blocked step

  Scenario: Passwords and codes require takeover rather than chat text
    When the model needs a password, passkey, or one-time code
    Then the required binding control is "human_takeover"
    And the worker does not accept the secret from the channel
