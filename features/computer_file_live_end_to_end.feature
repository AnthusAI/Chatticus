Feature: A member and a bot work on the same files of the computer, running or off, and each sees the other's changes

  As a member of an organization
  I want an edit I make in the Files panel to reach the bot, and what the bot writes to reach me
  So that the workplace is one set of files, whether the computer is running or off, and no change is lost

  These scenarios run the real routes with the real supervisor loop, the real file helper on a real directory, the real disk
  lifecycle (hydrate and publish through the snapshot store) and the real overlay applier. Only time, the child process of a
  turn, the model, the credential broker and the wait of the Front Door are faked. The contract is
  docs/LIVE_FILES_PROTOCOL.md; the server's own scenarios are in computer_file_live_member.feature,
  computer_file_live_operations.feature and computer_file_overlay.feature, and the supervisor's are in
  computer_file_live_supervisor.feature and computer_file_overlay_supervisor.feature.

  While the supervisor runs, a member's edit goes to it as a file request, runs through the file helper on the live disk, and
  is in the saved copy about thirty seconds later. While the computer is off, the edit waits in the overlay; the next owner
  seals the overlay after it restores the snapshot, applies it before any turn runs, and has it cleared once a publish that
  holds the edits is recorded. Edits made by hand and by a bot on the same file are judged by the hash the editor last saw.

  Background:
    Given an empty control plane
    And a fake owner credential broker
    And the organization is homed in the deployment account
    And the household computer of tenant "anthus" with members "ryan" and "mia"
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And an edit overlay over a snapshot bucket

  # ---------------------------------------------------------------- the computer is running

  @end-to-end
  Scenario: A member edits a file while no turn runs and the bot reads it back
    Given the model is scripted to call "read_workspace" with:
      """
      {"path": "/workspace/notes.md"}
      """
    And the model is scripted to answer "I read it."
    And a supervisor with the real computer disk is running for the household computer
    And the live disk holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the supervisor polls until the file request is answered
    Then the file response status is 200
    And the file response says "source" is "live"
    When bot "Researcher" is asked "read the notes"
    And bot "Researcher" works its turn until it waits for the computer
    And the supervisor polls until it is served
    Then the model saw "second draft" in its next request

  @end-to-end
  Scenario: Both sides edit the same file at once and exactly one edit stands
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/plan.md", "content": "from the bot"}
      """
    And the model is scripted to answer "Written."
    And a supervisor with the real computer disk is running for the household computer
    And the live disk holds workspace file "plan.md" containing "v1"
    And member "mia" has read the computer file "/workspace/plan.md" from the supervisor and holds its hash
    When bot "Researcher" is asked "rewrite the plan"
    And bot "Researcher" works its turn until it waits for the computer
    And the supervisor polls until it is served
    And member "mia" replaces the computer file "/workspace/plan.md" with "from Mia" if it still has the hash of "v1"
    And the supervisor polls until the file request is answered
    Then the file response status is 409
    And the file response error is "precondition_failed"
    And the file response says "current_sha256" is the hash of "from the bot"
    And the file "plan.md" on the live disk contains "from the bot"

  @end-to-end
  Scenario: An edit is in the saved copy after the quiet publish
    Given a supervisor with the real computer disk is running for the household computer
    And the live disk holds workspace file "notes.md" containing "first draft"
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And the supervisor polls until the file request is answered
    And 31 seconds go by while the supervisor runs
    Then the supervisor has published the snapshot
    And the saved snapshot now holds workspace file "notes.md" containing "second draft"

  # ---------------------------------------------------------------- the computer is off

  @end-to-end
  Scenario: An edit made while the computer is off is applied on the next hydrate and the bot sees it
    Given the model is scripted to call "read_workspace" with:
      """
      {"path": "/workspace/notes.md"}
      """
    And the model is scripted to answer "I read it."
    And the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    When member "mia" replaces the computer file "/workspace/notes.md" with "second draft" if it still has the hash of "first draft"
    And bot "Researcher" is asked "read the notes"
    And bot "Researcher" works its turn until it waits for the computer
    And a supervisor with the real computer disk is running for the household computer
    And the supervisor polls until it is served
    Then the model saw "second draft" in its next request
    And the file "notes.md" on the live disk contains "second draft"

  @end-to-end
  Scenario: The overlay is empty after the publish that holds the edit
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    And member "mia" replaced "/workspace/notes.md" with "second draft" while the computer was off
    And a supervisor with the real computer disk is running for the household computer
    When 6 seconds go by while the supervisor runs
    Then the supervisor has published the snapshot
    And the saved snapshot now holds workspace file "notes.md" containing "second draft"
    And the overlay holds no entry
    When the task is told to stop and the supervisor stops
    Then the overlay is empty and not sealed by a stopped owner

  @end-to-end
  Scenario: The overlay survives a crash of the owner before it publishes
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And no owner is running
    And member "mia" replaced "/workspace/notes.md" with "second draft" while the computer was off
    And a supervisor with the real computer disk is running for the household computer
    And the supervisor applied the overlay but has not published
    When the task is killed without a stopped report
    And 61 seconds go by while no supervisor runs
    Then a member reads the computer file "/workspace/notes.md" and gets "second draft" from the snapshot with the overlay
    And the edit overlay still holds an entry for "/workspace/notes.md"
    When a new supervisor with the real computer disk is started and hydrates
    Then the file "notes.md" on the live disk contains "second draft"

  @end-to-end
  Scenario: A file deleted and a file renamed while the computer is off are seen that way by the bot
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "ls", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Listed."
    And the computer disk holds workspace file "gone.txt" containing "g"
    And the computer disk holds workspace file "old.txt" containing "o"
    And the computer disk is published
    And no owner is running
    And member "mia" deleted "/workspace/gone.txt" and renamed "/workspace/old.txt" to "/workspace/new.txt" while the computer was off
    When bot "Researcher" is asked "list the workspace"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And bot "Researcher" works its turn until it waits for the computer
    And a supervisor with the real computer disk is running for the household computer
    And the supervisor polls until it is served
    Then the model saw "new.txt" in its next request
    And the model's next request does not contain "gone.txt"
    And the model's next request does not contain "old.txt"
