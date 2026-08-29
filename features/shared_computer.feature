Feature: Shared computer and isolated bot memory
  As a Chatticus user
  I want all of my bots to share one computer
  So that they can hand off files and signed-in sessions
  But I do not want one bot's memory mixed into another bot

  Scenario: Two bots share workspace files
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    When bot "Researcher" writes "notes.md" containing "weekly account list" on the computer
    Then bot "Writer" can read "notes.md" as "weekly account list" from the computer
    And both bots use the same computer

  Scenario: Browser sessions are shared on the computer
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    When bot "Researcher" saves a browser session "salesforce" as "signed-in"
    Then bot "Writer" sees browser session "salesforce" as "signed-in"

  Scenario: Bot memory is not shared
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    When bot "Researcher" remembers "voice" as "short and direct"
    Then bot "Writer" does not remember "voice"

  Scenario: Another user does not share that computer
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "alex" has a bot named "Ops"
    When bot "Researcher" writes "notes.md" containing "ryan only" on the computer
    Then bot "Ops" cannot read "notes.md" from its computer
