Feature: The starter and the whole owner path report their steps and leak no secret
  As the operator of an organization computer
  I want the starter to log the token it minted, the credentials it assumed and the task it started
  So that a turn that never gets an owner can be traced to the step that failed, and no log of the path carries a secret

  The starter writes one line for each step of an owner start: the gateway
  token minted (with its lifetime), the scoped credentials assumed (with the
  session name and the expiry), and the owner task started (with the task
  and the host start generation). A step that fails writes a line with the
  name of the AWS error and nothing else of it. No line carries the token,
  the credentials, the invoke key or the signing key.

  Background:
    Given an empty control plane
    And a turn parked on the workspace with its start job queued
    And the organization is homed in the deployment account

  Scenario: An owner start reports each step in order with its identifiers
    Given the starter has the owner settings
    When the starter handles the start job
    Then the starter log shows these events in order:
      | owner_token_minted         |
      | scoped_credentials_assumed |
      | owner_task_started         |
    And every starter log line names the tenant and the turn of the start job and the owner id of the container
    And the starter log line "owner_token_minted" has "lifetime_seconds" "3600"
    And the starter log line "scoped_credentials_assumed" has the session name of the owner id
    And the starter log line "scoped_credentials_assumed" has "expires_at" "2026-08-31T08:00:00.000Z"
    And the starter log line "owner_task_started" has "task_arn" "arn:aws:ecs:task/1"
    And the starter log line "owner_task_started" has "generation" "1"

  Scenario: A refused assume role is reported with the AWS error name and no task is started
    Given the starter has the owner settings
    And STS refuses the assume role with the error "AccessDenied"
    When the starter handles the start job
    Then the start was refused mentioning "denied by the fake"
    And the starter log shows these events in order:
      | owner_token_minted         |
      | scoped_credentials_failed  |
    And the starter log line "scoped_credentials_failed" has "error_name" "AccessDenied"
    And the starter log has no "owner_task_started" line
    And the starter log does not contain "denied by the fake"

  Scenario: A task that ECS could not start is reported with the failure
    Given the starter has the owner settings
    And ECS answers the run task with no task
    When the starter handles the start job
    Then the starter log shows these events in order:
      | owner_token_minted         |
      | scoped_credentials_assumed |
      | owner_task_failed          |
    And the starter log line "owner_task_failed" has "error_name" "Error"
    And the starter log has no "owner_task_started" line

  @owner-log
  Scenario: No line of the starter, the owner or the gateway carries a secret or the tool's own data
    Given the starter has the owner settings
    And the vendor answers "Good morning." using 120 input tokens and 30 output tokens
    When the starter handles the start job
    And the container takes over the turn with its task environment and is held after its tool ran
    And the container asks the model gateway for an answer through Pi and logs as its owner
    And held computer owner "started" is released
    Then the takeover of "started" ended "done"
    And the owner log of the started owner shows these events in order:
      | turn_claimed  |
      | tool_started  |
      | tool_finished |
      | model_call    |
    And the combined log text of the starter, the owner and the gateway contains none of:
      | the gateway token            |
      | the scoped access key id     |
      | the scoped secret access key |
      | the scoped session token     |
      | the invoke key               |
      | the signing key              |
      | the vendor key               |
      | the tool arguments           |
      | the tool output              |
