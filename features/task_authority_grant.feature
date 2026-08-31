Feature: Task-granted executable capability
  As a household member
  I want every task to name the tools, origins, recipients, file scopes, and
  egress classes a worker may use
  So that page content cannot expand what the task authorized

  Background:
    Given an empty control plane

  Scenario: A research task enumerates a closed grant
    Given a human task grants:
      | field          | value                    |
      | tools          | browse, read_workspace   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace/research      |
      | egress_classes | approved_origin_fetch    |
    Then the worker may invoke only the granted tools
    And the worker may fetch only the granted origins
    And the worker may address no recipients
    And the worker may read files only under the granted file scopes
    And the worker may emit only granted egress classes

  Scenario: A granted tool on an ungranted origin is denied
    Given a human task grants:
      | field          | value                    |
      | tools          | browse, read_workspace   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace/research      |
      | egress_classes | approved_origin_fetch    |
    When the model requests tool "browse" to origin "https://evil.example"
    Then the capability policy denies the request
    And no unblocked egress is recorded

  Scenario: A granted origin cannot add a recipient or file scope
    Given a human task grants:
      | field          | value                    |
      | tools          | browse, read_workspace   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace/research      |
      | egress_classes | approved_origin_fetch    |
    When the model requests tool "send" to recipient "exfil@evil.example"
    Then the capability policy denies the request
    When the model requests tool "read_workspace" for file "/workspace/secrets/notes.txt"
    Then the capability policy denies the request

  Scenario: Structured send requires the send tool, a granted recipient, and structured-send egress
    Given a human task grants:
      | field          | value                                  |
      | tools          | send                                   |
      | origins        |                                        |
      | recipients     | alex@example.com                       |
      | file_scopes    |                                        |
      | egress_classes | structured_send                        |
    When the model requests tool "send" to recipient "alex@example.com"
    Then the capability policy requires immutable approval
    When the model requests tool "send" to recipient "other@example.com"
    Then the capability policy denies the request
