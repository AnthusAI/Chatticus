Feature: Integration test session exchange
  As the Chatticus control plane
  I want a development-only IAM-role session exchange
  So automated live-stack tests can reach user routes without human OAuth

  Background:
    Given integration test auth is enabled for environment "development"
    And integration test auth allows role "arn:aws:iam::123456789012:role/chatticus-development-integration-test"
    And tenant "integration-test" is seeded for integration test user "integration-test-runner"

  Scenario: Allowed IAM role receives a bearer token
    When the integration test client requests a session with role "arn:aws:iam::123456789012:role/chatticus-development-integration-test"
    Then the integration test session response status is 200
    And the integration test session response includes a bearer token

  Scenario: Wrong IAM role is rejected
    When the integration test client requests a session with role "arn:aws:iam::123456789012:role/wrong-role"
    Then the integration test session response status is 403

  Scenario: Unsigned session exchange is rejected
    When the integration test client requests a session without caller credentials
    Then the integration test session response status is 403

  Scenario: Integration test auth is disabled in production
    Given integration test auth is enabled for environment "production"
    And integration test auth allows role "arn:aws:iam::123456789012:role/chatticus-development-integration-test"
    And the integration test front door is wired
    When the integration test client requests a session with role "arn:aws:iam::123456789012:role/chatticus-development-integration-test"
    Then the integration test session response status is 404

  Scenario: Integration bearer can create a channel and post a human message
    Given the integration test client has a session bearer token
    When the integration test client creates a channel with bot "SmokeBot"
    And the integration test client posts "hello from integration test" addressed to bot "SmokeBot"
    Then the integration test post message response status is 200

  Scenario: Expired integration bearer is rejected on user routes
    Given the integration test client has an expired session bearer token
    When the integration test client creates a channel with bot "SmokeBot"
    Then the integration test channel response status is 403

  Scenario: Integration bearer is rejected on worker-only routes
    Given the integration test client has a session bearer token
    And a worker registered over HTTP as:
      | worker_id    | smoke-worker |
      | tenant_id    | integration-test |
      | cost_class   | local        |
      | capabilities | cpu          |
    When the integration test client claims turn "missing-turn" as worker "smoke-worker"
    Then the integration test worker route response status is 403

  Scenario: Integration bearer cannot impersonate a different user id
    Given the integration test client has a session bearer token
    When the integration test client creates a channel for user "other-user" with bot "SmokeBot"
    Then the integration test channel response status is 403
