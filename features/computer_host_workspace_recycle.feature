Feature: Agent workspace files survive host recycle
  As a household member
  I want agent-written workspace files to persist across host relocate
  So that durable workplace bytes live in the organization snapshot bucket

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And a customer organization snapshot bucket bound to the host worker
    And tenant "anthus" user "ryan" has computer "household-computer"
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a human task grants:
      | field          | value                              |
      | tools          | browse, read_workspace, write_workspace |
      | origins        | https://docs.example.com           |
      | recipients     |                                    |
      | file_scopes    | /workspace/research                |
      | egress_classes | approved_origin_fetch, file_transfer |
    And a worker registered as:
      | worker_id   | garage-mac-1       |
      | tenant_id   | anthus             |
      | cost_class  | local              |
      | capabilities| computer,browser   |
      | computer_id | household-computer |
    And a worker registered as:
      | worker_id   | fargate-1          |
      | tenant_id   | anthus             |
      | cost_class  | fargate            |
      | capabilities| computer,browser   |
      | computer_id | household-computer |

  Scenario: An agent-written workspace file survives publish, relocate, and hydrate
    Given the household computer is stopped
    When bot "Researcher" is asked "write workspace file /workspace/research/recycle.txt containing persisted-by-agent"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn is waiting on the workspace capability
    And a computer continuation job is queued for the turn
    When the customer computer host "garage-mac-1" boots through the Front Door worker plane
    And a computer-capable pull worker with a workspace executor completes the escalated turn
    Then the turn journal records a successful write_workspace tool result
    When the customer computer host "garage-mac-1" shuts down through the Front Door worker plane
    Then the snapshot store has a pack in the organization snapshot bucket for tenant "anthus" computer "household-computer"
    When an administrator relocates computer "household-computer" to worker "fargate-1"
    When bot "Researcher" is asked "read workspace file /workspace/research/recycle.txt"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn is waiting on the workspace capability
    When the customer computer host "fargate-1" boots through the Front Door worker plane
    And a computer-capable pull worker with a workspace executor completes the escalated turn
    Then the active turn journal records a successful read_workspace tool result with content "persisted-by-agent"
