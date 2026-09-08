Feature: Computer host disk hydrate and publish
  As a household member
  I want the summoned computer host to hydrate on boot and publish before exit
  So that workplace files survive a ThinTurn recycle

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And a filesystem snapshot store bound to the host worker
    And tenant "anthus" user "ryan" has computer "household-computer"
    And a worker registered as:
      | worker_id   | fargate-1          |
      | tenant_id   | anthus             |
      | cost_class  | fargate            |
      | capabilities| computer,browser   |
      | computer_id | household-computer |
    And a worker registered as:
      | worker_id   | garage-mac-1       |
      | tenant_id   | anthus             |
      | cost_class  | local              |
      | capabilities| computer,browser   |
      | computer_id | household-computer |

  Scenario: The host hydrates a published snapshot before workspace readiness
    Given worker "fargate-1" has published computer "household-computer" with workspace file "notes.md" containing "weekly account list"
    When an administrator relocates computer "household-computer" to worker "garage-mac-1"
    When the customer computer host "garage-mac-1" boots through the Front Door worker plane
    Then computer "household-computer" does not require hydrate
    And host "garage-mac-1" has workspace file "notes.md" containing "weekly account list"
    And tenant "anthus" household computer readiness reports workspace ready after model

  Scenario: The host publishes a dirty disk before exit
    When the customer computer host "garage-mac-1" boots through the Front Door worker plane
    And host "garage-mac-1" writes workspace file "notes.md" containing "unsynced edits"
    And the customer computer host "garage-mac-1" shuts down through the Front Door worker plane
    Then the snapshot store has a pack for tenant "anthus" computer "household-computer"
    And tenant "anthus" computer "household-computer" is not dirty on the store

  Scenario: Published file bytes survive a control plane recycle
    Given worker "fargate-1" has published computer "household-computer" with workspace file "notes.md" containing "weekly account list"
    When the customer computer host "garage-mac-1" boots through the Front Door worker plane
    And host "garage-mac-1" writes workspace file "notes.md" containing "after boot"
    And the customer computer host "garage-mac-1" shuts down through the Front Door worker plane
    When the Front Door is recycled onto the same messaging store
    And the customer computer host "garage-mac-1" boots through the Front Door worker plane
    Then host "garage-mac-1" has workspace file "notes.md" containing "after boot"

  Scenario: A second hydrate is a cache hit when the checksum already matches
    Given worker "fargate-1" has published computer "household-computer" with workspace file "notes.md" containing "weekly account list"
    When the customer computer host "garage-mac-1" boots through the Front Door worker plane
    And the customer computer host "garage-mac-1" boots through the Front Door worker plane
    Then the snapshot store served 1 pack download

  Scenario: A host worker cannot publish snapshot metadata for another worker
    When worker "garage-mac-1" posts snapshot publish metadata as worker "fargate-1"
    Then snapshot metadata publish is rejected with forbidden

  Scenario: The host boots without a configured snapshot store
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has computer "household-computer"
    And a worker registered as:
      | worker_id   | garage-mac-1       |
      | tenant_id   | anthus             |
      | cost_class  | local              |
      | capabilities| computer,browser   |
      | computer_id | household-computer |
    When the customer computer host "garage-mac-1" boots without a snapshot store
    Then tenant "anthus" household computer readiness reports workspace ready after model
    And tenant "anthus" household computer readiness reports browser ready after workspace
    And the Front Door received no snapshot hydrate or publish requests
