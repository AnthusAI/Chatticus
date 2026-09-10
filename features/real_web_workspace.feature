Feature: Real Chatticus workspace
  As an organization member
  I want bots, named channels, conversation, and work context in one workspace
  So that I can continue real work without navigating proof-of-concept panels

  Scenario: Individual bots and named channels share one roster
    Given the real workspace has bots "Researcher" and "Writer"
    And it has named channel "Applied Research" with those bots
    When the real workspace builds its roster
    Then "Researcher" and "Writer" are individual bot rows
    And "Applied Research" is a named channel row with 2 bot avatars

  Scenario: Selecting a bot continues its one durable direct conversation
    Given the real workspace bot "Researcher" has a direct channel with committed history
    When the member selects bot "Researcher" twice
    Then both selections use the same direct channel
    And the committed history remains visible

  Scenario: A named channel message addresses one participating bot
    Given the real workspace has named channel "Applied Research" with bots "Researcher" and "Writer"
    When the member addresses "Writer" and sends "Draft the findings"
    Then the message stays in "Applied Research"
    And the message is addressed to "Writer"

  Scenario: Reloading a conversation restores durable and active work
    Given a real workspace channel has committed messages and an active waiting turn
    When the real workspace reloads that conversation
    Then the committed messages are visible in sequence
    And the active turn is shown as waiting

  Scenario Outline: Turn progress remains explicit through its lifecycle
    Given a real workspace turn is "<state>"
    When the real workspace presents the turn
    Then its visible state is "<label>"

    Examples:
      | state       | label        |
      | streaming   | Responding   |
      | waiting     | Waiting      |
      | completed   | Completed    |
      | failed      | Failed       |
      | reconciling | Reconciling  |

  Scenario Outline: Roster loading failures and empty results remain explicit
    Given the real workspace roster is "<state>"
    When the real workspace presents the roster
    Then its visible state is "<label>"

    Examples:
      | state   | label                  |
      | loading | Loading conversations  |
      | empty   | No bots or channels    |
      | error   | Roster failed to load  |

  Scenario: The inspector uses only real computer and task context
    Given the real workspace selected bot "Researcher" created one task
    And the organization computer is stopped with policy "prefer_local"
    When the member opens the real workspace inspector
    Then the inspector shows the stopped computer and policy "prefer_local"
    And the inspector shows the task created by "Researcher"
    And the inspector offers no unsupported computer control

  Scenario: Narrow and keyboard workspace navigation preserves access
    Given the real workspace uses a narrow viewport
    When the member opens the roster and inspector using the keyboard
    Then both regions open as named sheets
    And every icon-only control has an accessible name
    And keyboard focus remains visible
