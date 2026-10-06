Feature: Each capability check denies on its own
  As a household member
  I want every dimension of a task grant enforced independently
  So that a request that exceeds only one dimension is still denied

  Background:
    Given an empty control plane
    And a human task grants:
      | field          | value                            |
      | tools          | browse, read_workspace, send     |
      | origins        | https://docs.example.com         |
      | recipients     | alex@example.com                 |
      | file_scopes    | /workspace/research              |
      | egress_classes | approved_origin_fetch, structured_send |

  Scenario: A tool outside the grant is denied when nothing else is wrong
    When the model requests tool "run_terminal" with no destination
    Then the capability policy denies the request

  Scenario: An egress class outside the grant is denied when nothing else is wrong
    When the model requests tool "browse" with egress class "file_transfer"
    Then the capability policy denies the request

  Scenario: An origin outside the grant is denied when nothing else is wrong
    When the model requests tool "browse" to origin "https://evil.example"
    Then the capability policy denies the request

  Scenario: A recipient outside the grant is denied when nothing else is wrong
    When the model requests tool "send" to recipient "other@example.com"
    Then the capability policy denies the request

  Scenario: A file outside the granted scopes is denied when nothing else is wrong
    When the model requests tool "read_workspace" for file "/workspace/secrets/notes.txt"
    Then the capability policy denies the request

  Scenario: A request inside every dimension of the grant is allowed
    When the model requests tool "browse" to origin "https://docs.example.com/guide"
    Then the capability policy allows the request
    And no unblocked egress is recorded

  Scenario: Egress outside the grant is never let through
    When the model requests tool "browse" to origin "https://evil.example/collect"
    Then no unblocked egress is recorded
