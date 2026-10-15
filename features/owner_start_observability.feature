Feature: The starter and the whole owner path report their steps and leak no secret
  As the operator of an organization computer
  I want the starter to log the token it minted and the task it started, and the Front Door to log what it handed out
  So that a turn that never gets an owner can be traced to the step that failed, and no log of the path carries a secret

  The starter writes one line for each step of an owner start: the bootstrap
  token minted (with its lifetime) and the owner task started (with the task
  and the host start generation). A step that fails writes a line with the name
  of the AWS error and nothing else of it. The Front Door writes a line when the
  owner exchanges its token and for each dispatch it offers. No line carries the
  bootstrap token, the supervisor token, the gateway token, the credentials of a
  turn, the invoke key or the signing key.

  Background:
    Given an empty control plane
    And a turn parked on the workspace with its start job queued
    And the organization is homed in the deployment account

  Scenario: An owner start reports each step in order with its identifiers
    Given the starter has the owner settings
    When the starter handles the start job
    Then the starter log shows these events in order:
      | owner_token_minted |
      | owner_task_started |
    And every starter log line names the tenant and the turn of the start job and the owner id of the container
    And the starter log line "owner_token_minted" has "lifetime_seconds" "300"
    And the starter log line "owner_task_started" has "task_arn" "arn:aws:ecs:task/1"
    And the starter log line "owner_task_started" has "generation" "1"

  Scenario: A task that ECS could not start is reported with the failure
    Given the starter has the owner settings
    And ECS answers the run task with no task
    When the starter handles the start job
    Then the starter log shows these events in order:
      | owner_token_minted |
      | owner_task_failed  |
    And the starter log line "owner_task_failed" has "error_name" "Error"
    And the starter log has no "owner_task_started" line

  @owner-log
  Scenario: No line of the starter, the Front Door, the owner or the gateway carries a secret or the tool's own data
    Given the starter has the owner settings
    And the vendor answers "Good morning." using 120 input tokens and 30 output tokens
    When the starter handles the start job
    And the owner exchanges its bootstrap token and is offered the parked turn
    And the container takes over the turn with its dispatch and is held after its tool ran
    And the container asks the model gateway for an answer through Pi and logs as its owner
    And held computer owner "started" is released
    Then the takeover of "started" ended "done"
    And the Front Door log shows these events in order:
      | owner_bootstrap_ok     |
      | owner_dispatch_offered |
    And the owner log of the started owner shows these events in order:
      | turn_claimed  |
      | tool_started  |
      | tool_finished |
      | model_call    |
    And the combined log text of the starter, the Front Door, the owner and the gateway contains none of:
      | the bootstrap token          |
      | the supervisor token         |
      | the gateway token            |
      | the turn's access key id     |
      | the turn's secret access key |
      | the turn's session token     |
      | the supervisor's secret key  |
      | the invoke key               |
      | the signing key              |
      | the vendor key               |
      | the tool arguments           |
      | the tool output              |
