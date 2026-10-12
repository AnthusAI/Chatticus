Feature: The starter launches the computer as a supervisor that holds one bootstrap token and no role
  As the operator of an organization computer
  I want the starter to launch the computer as an owner that holds nothing but a short-lived bootstrap token
  So that the container asks the control plane for its credentials, and neither the model key nor any storage access sits in a task description

  A computer homed in the deployment account always starts as a supervisor: the
  container exchanges its bootstrap token once for a supervisor token and
  supervisor credentials, then asks the control plane for work and runs each
  turn in a child process. A computer homed in a customer account starts as the
  host worker that serves computer actions over HTTP and never gets an owner.
  Every owner start generates a fresh owner id and binds one token to it: the
  bootstrap token, which names the organization, the computer, the owner id and
  the claimed host start generation, lives five minutes and works once. The
  starter assumes no role, mints no gateway token and no host token, and puts no
  AWS credential in the task: the credential broker issues the supervisor's
  credentials at the exchange and each turn's credentials at dispatch. The
  vendor key never leaves the control plane.

  Background:
    Given an empty control plane
    And a turn parked on the workspace with its start job queued
    And the organization is homed in the deployment account

  Scenario: A computer in the deployment account starts as the supervisor and runs the supervisor task with its command and the computer's identity
    Given the starter has the owner settings
    When the starter handles the start job
    Then the start ended "started"
    And the starter ran exactly 1 ECS task
    And the task ran task definition "owner-computer:3" in cluster "computers"
    And the task overrode container "owner" with the command "node /opt/chatticus/host/supervisor.mjs"
    And the container environment names the organization, the computer and the member of the start job
    And the container environment holds a fresh owner id

  Scenario: The supervisor finds its stores, its gateway and the Front Door in its environment
    Given the starter has the owner settings
    When the starter handles the start job
    Then the container environment holds:
      | CHATTICUS_MODEL_GATEWAY_URL    | https://front-door.test/orgs/anthus/model-gateway/v1 |
      | CHATTICUS_FRONT_DOOR_URL       | https://front-door.test                              |
      | CHATTICUS_CONVERSATIONS_TABLE  | conversations-table                                  |
      | CHATTICUS_PI_SESSIONS_BUCKET   | pi-sessions-bucket                                   |
      | CHATTICUS_SNAPSHOT_BUCKET      | snapshot-bucket                                      |
      | CHATTICUS_ENVIRONMENT          | development                                          |
      | AWS_REGION                     | us-east-1                                            |
    And the container environment holds the table of the messaging store
    And the container environment holds no invoke key and no copy of the invoke key's value

  Scenario: The starter holds no role and puts one secret in the task
    Given the starter has the owner settings
    When the starter handles the start job
    Then the starter assumed no role
    And the container environment names no turn, no bot, no gateway token, no host token and no AWS credential
    And the container environment holds exactly one secret: a bootstrap token valid for 300 seconds
    And the bootstrap token names the organization, the computer, the new owner id and the claimed generation
    And the starter registered the owner as a worker of the household computer

  Scenario: The bootstrap token opens the bootstrap route and nothing else
    Given the starter has the owner settings
    When the starter handles the start job
    Then the bootstrap token is not valid as a supervisor token or as a gateway token

  Scenario Outline: An identifier that cannot be a session tag value stops the start before a task runs
    Given the starter has the owner settings
    And the computer of the organization has the identifier "<computer>"
    When the starter handles the start job
    Then the start was refused mentioning "<tag>"
    And the starter ran exactly 0 ECS tasks
    And the organization has no worker registered by the starter

    Examples:
      | computer     | tag      |
      | computer*one | computer |
      | computer#one | computer |
      | computer%23x | computer |
      | has space    | computer |

  Scenario: Every start generation gets its own owner id and bootstrap token
    Given the starter has the owner settings
    When the starter handles the start job
    And the host start lease expires and the starter handles the start job
    Then the second task has a different owner id and a different bootstrap token from the first

  Scenario: One start generation starts one owner however many jobs arrive
    Given the starter has the owner settings
    When the starter handles the start job
    And the starter handles the start job again
    Then the start ended "already_started"
    And the starter ran exactly 1 ECS task

  Scenario: No log of the starter carries a token, a key or a credential
    Given the starter has the owner settings
    When the starter handles the start job
    Then the starter logged none of the bootstrap token, the invoke key and the signing key

  Scenario: A starter that launches computers refuses to start without any owner settings
    Given the organization is homed in the deployment account
    When the starter is composed
    Then the starter was refused at composition mentioning "CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_SECRET_ARN"

  Scenario: A computer in a customer's account starts as the host worker and never gets an owner
    Given the organization is homed in the account "210987654321" with a ChatticusComputers stack and a cross-account role
    And the starter has the owner settings
    When the starter handles the start job
    Then the start ended "started"
    And the cross-account role was assumed exactly 1 time
    And the customer account ran exactly 1 ECS task
    And the customer task overrode container "computer" with the command "node /opt/chatticus/host/host-worker.mjs"
    And the starter ran exactly 0 ECS tasks
    And the organization has no worker registered by the starter

  Scenario: A computer in a customer's account without a cross-account role is refused and never gets an owner
    Given the organization is homed in the account "210987654321" with no cross-account role
    And the starter has the owner settings
    When the starter handles the start job
    Then the start ended "refused"
    And the parked turn failed telling the person the organization has no computer set up yet
    And the start job is not retried
    And the starter ran exactly 0 ECS tasks
    And no cross-account role was assumed

  Scenario: An organization with no AWS home fails the parked turn at once and the start job is never retried
    Given the organization has no AWS home
    And the starter has the owner settings
    When the starter handles the start job
    Then the start ended "refused"
    And the parked turn failed telling the person the organization has no computer set up yet
    And the start job is not retried
    And no start job is left for the dead-letter queue
    And the starter made exactly 1 start attempt
    And the starter ran exactly 0 ECS tasks
    And the starter logged one "computer_start_refused" line with the tenant, the turn and the reason class "no_aws_home"

  Scenario: A transient AWS error still leaves the parked turn waiting and the start job to be retried
    Given the starter has the owner settings
    And ECS answers the run task with no task
    When the starter handles the start job
    Then the start failed and the parked turn is still waiting
    And the start job is queued again
    And the starter logged no "computer_start_refused" line
