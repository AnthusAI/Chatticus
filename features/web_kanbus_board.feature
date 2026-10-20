Feature: Members see the Kanbus board of the workspace in the Board panel
  As a member of an organization
  I want the Board tab to show the Kanbus issues that live in the computer's workspace
  So that I can see what the bots are working on, in columns by status, without asking in chat

  The panel reads the issue files of a Kanbus project (one JSON file per issue under project/issues) through the member
  file routes, so it works with the computer off, from the saved copy. These scenarios run the real Board controller and
  the real rendered panel against a fake running computer that answers the file routes with the shapes of
  host-protocol/src/live-files.ts, with a fixed clock. The panel only reads: it never writes to the workspace.

  # ---------------------------------------------------------------- the board

  @web
  Scenario: The Board tab shows the issues in columns by status
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id    | title                  | status      | priority | labels        | type | parent |
      | cx-1  | Ship the board panel   | in_progress | 1        | web, ui       | task | cx-0   |
      | cx-2  | Write the guide        | open        | 2        | docs          | task |        |
      | cx-3  | Fix the login redirect | open        | 0        | web           | bug  |        |
      | cx-4  | Rotate the keys        | closed      | 3        |               | task |        |
      | cx-5  | Wait for the vendor    | blocked     | 2        |               | task |        |
    When the member opens the Board tab
    Then the board is named "chatticus board"
    And the board says "5 issues"
    And the board column "open" lists "cx-3, cx-2"
    And the board column "in_progress" lists "cx-1"
    And the board column "blocked" lists "cx-5"
    And the board column "closed" lists "cx-4"
    And the board column "open" has a count of 2

  @web
  Scenario: A card shows the title, id, priority, labels and where it sits in the hierarchy
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title                | status      | priority | labels  | type | parent |
      | cx-0 | Workspace redesign   | in_progress | 1        |         | epic |        |
      | cx-1 | Ship the board panel | in_progress | 1        | web, ui | task | cx-0   |
    When the member opens the Board tab
    Then the card "cx-1" shows "Ship the board panel"
    And the card "cx-1" shows "cx-1"
    And the card "cx-1" shows "High"
    And the card "cx-1" shows "web"
    And the card "cx-1" shows "ui"
    And the card "cx-1" shows "Under cx-0"
    And the card "cx-0" shows "1 child"

  @web
  Scenario: The board says whether it shows the live computer or a saved copy
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    When the member opens the Board tab
    Then the board says "Live from the computer"
    When the board's computer is switched off
    And the member refreshes the board
    Then the board says "Computer is off. Showing the copy saved 5 minutes ago"
    And the board column "open" lists "cx-2"

  @web
  Scenario: A Kanbus project in the top folder of the workspace is found
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    When the member opens the Board tab
    Then the board is named "Workspace board"
    And the board column "open" lists "cx-2"

  # ---------------------------------------------------------------- refreshing and limits

  @web
  Scenario: Refreshing reads only the issue files that changed
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-1 | Ship the board  | open   | 2        |
      | cx-2 | Write the guide | open   | 2        |
      | cx-3 | Fix the redirect| open   | 2        |
    When the member opens the Board tab
    Then the board read 3 issue files
    When the bot moves issue "cx-2" of "chatticus" to the status "in_progress"
    And the member refreshes the board
    Then the board read 1 issue file again
    And the board column "in_progress" lists "cx-2"
    And the board column "open" lists "cx-1, cx-3"

  @web
  Scenario: A board larger than the limit shows the most recently changed issues and says so
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds 230 Kanbus issues
    When the member opens the Board tab
    Then the board says "Showing the 200 most recently changed of 230 issues"
    And the board read 200 issue files

  @web
  Scenario: A long column shows its first cards and says how many more it holds
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds 35 Kanbus issues
    When the member opens the Board tab
    Then the board column "open" has a count of 35
    And the board says "and 5 more"

  @web
  Scenario: A file that is not an issue is left out and counted
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace folder "chatticus" holds a Kanbus project with these issues
      | id   | title           | status | priority |
      | cx-2 | Write the guide | open   | 2        |
    And the workspace holds the file "chatticus/project/issues/broken.json" containing "{ not json"
    When the member opens the Board tab
    Then the board column "open" lists "cx-2"
    And the board says "1 file could not be read as an issue"

  # ---------------------------------------------------------------- nothing to show

  @web
  Scenario: A workspace without a Kanbus project says so
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the workspace holds the file "notes/plan.md" containing "no board here"
    When the member opens the Board tab
    Then the board says "No Kanbus project in the workspace yet"
    And the board says "project/issues"

  @web
  Scenario: A computer that cannot answer shows a plain message and a way to try again
    Given the board view for "ryan@example.com" in "Anthus Labs" with a running computer
    And the computer answers every file request that it is busy
    When the member opens the Board tab
    Then the board says "The computer is busy with other requests"
    When the computer answers file requests normally again
    And the member refreshes the board
    Then the board says "No Kanbus project in the workspace yet"
