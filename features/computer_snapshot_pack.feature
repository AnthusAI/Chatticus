Feature: Hosts publish and hydrate computer packs
  As a Chatticus administrator
  I want a shared snapshot store any host can see
  So that I can run a computer on a Mac or on Fargate without copying containers

  Background:
    Given a filesystem snapshot store
    And a computer host named "fargate"
    And a computer host named "garage-mac"

  Scenario: A Mac hydrates from the same store a Fargate host published
    When host "fargate" writes workspace file "notes.md" containing "weekly account list"
    And host "fargate" writes browser profile file "Default/Cookies" containing "signed-in"
    And host "fargate" publishes computer "household-computer" for tenant "anthus" as worker "fargate-1"
    Then the snapshot store has a pack for tenant "anthus" computer "household-computer"
    When host "garage-mac" hydrates computer "household-computer" for tenant "anthus"
    Then host "garage-mac" has workspace file "notes.md" containing "weekly account list"
    And host "garage-mac" has browser profile file "Default/Cookies" containing "signed-in"

  Scenario: Hydrate replaces stale files left on the target host
    When host "garage-mac" writes workspace file "stale.md" containing "do not keep"
    And host "fargate" writes workspace file "notes.md" containing "canonical"
    And host "fargate" publishes computer "household-computer" for tenant "anthus" as worker "fargate-1"
    And host "garage-mac" hydrates computer "household-computer" for tenant "anthus"
    Then host "garage-mac" has workspace file "notes.md" containing "canonical"
    And host "garage-mac" does not have workspace file "stale.md"

  Scenario: A second hydrate is a cache hit when the checksum already matches
    When host "fargate" writes workspace file "notes.md" containing "weekly account list"
    And host "fargate" publishes computer "household-computer" for tenant "anthus" as worker "fargate-1"
    And host "garage-mac" hydrates computer "household-computer" for tenant "anthus"
    And host "garage-mac" hydrates computer "household-computer" for tenant "anthus"
    Then the snapshot store served 1 pack download
