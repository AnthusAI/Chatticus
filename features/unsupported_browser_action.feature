Feature: Unsupported authenticated browser action
  As a household member
  I want browser actions with unbound consequences to stop
  So that a persuasive screenshot or click coordinate is not treated as meaningful approval

  Scenario Outline: A generic browser would perform a consequential action
    Given an empty control plane
    And no structured connector or takeover control can bind the exact operation
    When the model attempts to <action> through an authenticated browser
    Then the action is not executed
    And the turn reports that user-controlled completion is required

    Examples:
      | action             |
      | send               |
      | publish            |
      | purchase           |
      | delete             |
      | change production  |
