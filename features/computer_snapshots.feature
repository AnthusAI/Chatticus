Feature: Computer snapshots and host relocate
  As a Chatticus administrator
  I want durable computer state in object storage
  So that any host can hydrate a workplace without live-migrating a container

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has computer "household-computer"
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer,browser |
      | computer_id | household-computer |
    And a worker registered as:
      | worker_id   | fargate-1 |
      | tenant_id   | anthus    |
      | cost_class  | fargate   |
      | capabilities| computer,browser |
      | computer_id | household-computer |

  Scenario: Publishing records a snapshot URI every host can see
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    When bot "Researcher" writes "notes.md" containing "weekly account list" on the computer
    And worker "fargate-1" publishes a snapshot of computer "household-computer"
    Then computer "household-computer" has snapshot URI "s3://chatticus/tenants/anthus/computers/household-computer/snapshot"
    And computer "household-computer" is not dirty

  Scenario: Files in a published snapshot survive relocate onto another host
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    When bot "Researcher" writes "notes.md" containing "weekly account list" on the computer
    And bot "Researcher" saves a browser session "salesforce" as "signed-in"
    And worker "fargate-1" publishes a snapshot of computer "household-computer"
    And an administrator relocates computer "household-computer" to worker "garage-mac-1"
    Then bot "Researcher" can read "notes.md" as "weekly account list" from the computer
    And bot "Researcher" sees browser session "salesforce" as "signed-in"
    When worker "garage-mac-1" hydrates computer "household-computer"
    Then bot "Researcher" can read "notes.md" as "weekly account list" from the computer
    And computer "household-computer" does not require hydrate

  Scenario: Relocate without a snapshot is rejected
    When an administrator relocates computer "household-computer" to worker "garage-mac-1"
    Then relocate fails because a snapshot is required

  Scenario: Unpublished live-disk writes block relocate
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    When bot "Researcher" writes "notes.md" containing "weekly account list" on the computer
    And worker "fargate-1" publishes a snapshot of computer "household-computer"
    And bot "Researcher" writes "notes.md" containing "unsynced edits" on the computer
    And an administrator relocates computer "household-computer" to worker "garage-mac-1"
    Then relocate fails because the disk is dirty

  Scenario: Relocate pins turns to the intended host until it hydrates
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    When bot "Researcher" writes "notes.md" containing "weekly account list" on the computer
    And worker "fargate-1" publishes a snapshot of computer "household-computer"
    And an administrator relocates computer "household-computer" to worker "fargate-1"
    And tenant "anthus" enqueues a turn:
      | capabilities | computer |
      | computer_id  | household-computer |
    Then the turn is assigned to worker "fargate-1"

  Scenario: After the intended host hydrates, a stale local host is not preferred
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    When bot "Researcher" writes "notes.md" containing "weekly account list" on the computer
    And worker "fargate-1" publishes a snapshot of computer "household-computer"
    And an administrator relocates computer "household-computer" to worker "fargate-1"
    And worker "fargate-1" hydrates computer "household-computer"
    And tenant "anthus" enqueues a turn:
      | capabilities | computer |
      | computer_id  | household-computer |
    Then the turn is assigned to worker "fargate-1"

  Scenario: A worker that does not host the computer cannot hydrate it
    Given a worker registered as:
      | worker_id   | other-mac |
      | tenant_id   | anthus    |
      | cost_class  | local     |
      | capabilities| computer  |
      | computer_id | someone-elses-computer |
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When bot "Researcher" writes "notes.md" containing "weekly account list" on the computer
    And worker "fargate-1" publishes a snapshot of computer "household-computer"
    And an administrator relocates computer "household-computer" to worker "garage-mac-1"
    And worker "other-mac" hydrates computer "household-computer"
    Then hydrate fails because the worker does not host that computer

  Scenario: The live disk cannot be written until the intended host hydrates
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    When bot "Researcher" writes "notes.md" containing "weekly account list" on the computer
    And worker "fargate-1" publishes a snapshot of computer "household-computer"
    And an administrator relocates computer "household-computer" to worker "garage-mac-1"
    And bot "Researcher" writes "scratch.md" containing "too soon" on the computer
    Then writing the computer fails because it is not hydrated
