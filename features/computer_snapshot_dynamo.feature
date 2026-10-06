Feature: Computer snapshot metadata survives Dynamo recycle
  As a Chatticus administrator
  I want snapshot metadata persisted in Dynamo
  So that a ThinTurn recycle does not drop relocate and publish state

  Background:
    Given an empty control plane backed by a Dynamo messaging store
    And tenant "anthus" user "ryan" has computer "household-computer"
    And a worker registered as:
      | worker_id    | fargate-1          |
      | tenant_id    | anthus             |
      | cost_class   | fargate            |
      | capabilities | computer,browser   |
      | computer_id  | household-computer |
    And a worker registered as:
      | worker_id    | garage-mac-1       |
      | tenant_id    | anthus             |
      | cost_class   | local              |
      | capabilities | computer,browser   |
      | computer_id  | household-computer |

  Scenario: Published snapshot metadata survives a control plane recycle on Dynamo
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    When bot "Researcher" writes "notes.md" containing "weekly account list" on the computer
    And worker "fargate-1" publishes a snapshot of computer "household-computer"
    And an administrator relocates computer "household-computer" to worker "garage-mac-1"
    When the control plane is recycled onto the same messaging store
    Then tenant "anthus" computer "household-computer" has snapshot URI "s3://chatticus/tenants/anthus/computers/household-computer/snapshot"
    And tenant "anthus" computer "household-computer" has snapshot generation 1
    And tenant "anthus" computer "household-computer" has snapshot checksum for file "notes.md" as "weekly account list"
    And tenant "anthus" computer "household-computer" is not dirty on the store
    And tenant "anthus" computer "household-computer" requires hydrate on worker "garage-mac-1"

  Scenario: Unpublished writes mark disk dirty across a Dynamo recycle
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    When bot "Researcher" writes "notes.md" containing "unsynced edits" on the computer
    When the control plane is recycled onto the same messaging store
    Then tenant "anthus" computer "household-computer" is dirty on the store
