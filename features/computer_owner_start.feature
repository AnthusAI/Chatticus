Feature: The starter launches the computer as a container owner
  As the operator of an organization computer
  I want the starter to launch the computer as an owner that holds only a gateway token and scoped credentials
  So that the bot's session runs next to the workspace while the container never holds the model key or broad storage access

  A computer homed in the deployment account always starts as the owner: the
  container takes the parked turn over and runs its Pi session itself. A
  computer homed in a customer account starts as the host worker that serves
  computer actions over HTTP and never gets an owner. Every owner start
  generates a fresh owner id. The id is bound
  into the model gateway token, passed to the container as the worker id of
  its claim on the turn, and used to name the scoped storage credentials the
  starter obtains from STS with a session policy for this organization,
  computer and conversation. The vendor key never leaves the control plane.

  Background:
    Given an empty control plane
    And a turn parked on the workspace with its start job queued
    And the organization is homed in the deployment account

  Scenario: A computer in the deployment account starts as the owner and runs the owner task with its command and the turn's identity
    Given the starter has the owner settings
    When the starter handles the start job
    Then the start ended "started"
    And the starter ran exactly 1 ECS task
    And the task ran task definition "owner-computer:3" in cluster "computers"
    And the task overrode container "owner" with the command "node /opt/chatticus/host/owner.mjs"
    And the container environment names the turn, the bot and the member of the start job
    And the container environment holds a fresh owner id

  Scenario: The owner finds its stores, its gateway and the Front Door in its environment
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
    And the container environment holds the invoke key read from its secret

  Scenario: The gateway token is bound to the owner id the container receives
    Given the starter has the owner settings
    When the starter handles the start job
    Then the gateway token binds the turn, the bot and the owner id of the container for 3600 seconds

  Scenario: The scoped credentials come from STS with a session policy for this conversation and computer
    Given the starter has the owner settings
    When the starter handles the start job
    Then STS was asked exactly 1 time to assume the role "arn:aws:iam::123456789012:role/owner-scoped"
    And the session name is derived from the owner id and the session lasts 3600 seconds
    And the session policy is the owner policy for the turn's conversation and the computer
    And the container environment holds the scoped credentials STS returned

  Scenario: The session policy fits within what STS accepts
    Given the starter has the owner settings
    When the starter handles the start job
    Then the session policy is within the STS size limit

  Scenario: Every start generation gets its own owner id and gateway token
    Given the starter has the owner settings
    When the starter handles the start job
    And the host start lease expires and the starter handles the start job
    Then the second task has a different owner id and a different gateway token from the first
    And STS was asked exactly 2 times to assume the role "arn:aws:iam::123456789012:role/owner-scoped"

  Scenario: One start generation starts one owner however many jobs arrive
    Given the starter has the owner settings
    When the starter handles the start job
    And the starter handles the start job again
    Then the start ended "already_started"
    And the starter ran exactly 1 ECS task
    And STS was asked exactly 1 time to assume the role "arn:aws:iam::123456789012:role/owner-scoped"

  Scenario: No log of the starter carries a token, a credential or a key
    Given the starter has the owner settings
    When the starter handles the start job
    Then the starter logged none of the gateway token, the scoped credentials, the invoke key and the signing key

  Scenario: The container that takes the turn over under its owner id is served by the gateway with its token
    Given the starter has the owner settings
    And the vendor answers "Good morning." using 120 input tokens and 30 output tokens
    When the starter handles the start job
    And the container takes over the turn with its task environment and is held after its tool ran
    And the container asks the model gateway for an answer with the token of its start
    Then the gateway answers with status 200
    And the owner that took the turn over claimed it under the owner id of the start
    When held computer owner "started" is released
    Then the takeover of "started" ended "done"

  Scenario: The starter refuses to start without the role the owner credentials come from
    Given the starter has the owner settings without the setting "CHATTICUS_OWNER_SCOPED_ROLE_ARN"
    When the starter is composed
    Then the starter was refused at composition mentioning "CHATTICUS_OWNER_SCOPED_ROLE_ARN"

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
    And STS was not asked to assume a scoped role

  Scenario: A computer in a customer's account without a cross-account role is refused and never gets an owner
    Given the organization is homed in the account "210987654321" with no cross-account role
    And the starter has the owner settings
    When the starter handles the start job
    Then the start was refused mentioning "no cross-account role"
    And the starter ran exactly 0 ECS tasks
    And STS was not asked to assume a scoped role
    And no cross-account role was assumed
