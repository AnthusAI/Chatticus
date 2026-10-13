Feature: Members view and edit the computer's files in the web panel
  As a member of an organization
  I want the Files tab to say plainly where the files come from and to let me change them
  So that I can fix a file, a folder or a name without sending a chat message, with the computer on or off

  The panel mirrors the JSON of the member file routes (host-protocol/src/live-files.ts and edit-overlay.ts) in its own
  types. These scenarios run the real panel logic and the real rendered panel against a fake running computer that
  answers the routes with those shapes, with a fake clock, so the 2, 5 and 15 second behavior is exact. A change made
  while the computer is off is kept for it (an overlay): the panel says so, marks the file, and lists what is waiting.

  # ---------------------------------------------------------------- the web app

  @web
  Scenario: The panel says whether it shows the live computer or a saved copy
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    When the member opens the Files tab
    Then the panel shows the source "Live from the computer"
    When the computer is off
    And the member refreshes the files
    Then the panel shows the source "Computer is off. Showing the copy saved 5 minutes ago"

  @web
  Scenario: A fallback to the saved copy says so and tries again
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the next live read times out
    When the member opens the Files tab
    Then the panel shows "Could not reach the running computer. Showing the saved copy"
    And the panel asks again after 2 seconds
    And the editor is not offered
    When the clock advances 2 seconds
    Then the panel shows the source "Live from the computer"

  @web
  Scenario: A member edits and saves a file
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the live computer holds workspace file "notes.md" containing "first draft"
    When the member opens "/workspace/notes.md" and chooses Edit
    And the member replaces the text with "second draft" and chooses Save
    Then the panel shows "Saved on the computer"
    And the live computer now holds workspace file "notes.md" containing "second draft"

  @web
  Scenario: Leaving an edited file asks first
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the member is editing "/workspace/notes.md" and has changed the text
    When the member chooses Back to folder
    Then the panel asks whether to discard the changes

  @web
  Scenario: A conflict shows a banner with the other version
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the member is editing "/workspace/plan.md" containing "v1" and has typed "v2 from Mia"
    And the bot changed that file to "v2 from Pi" on the computer
    When the member chooses Save
    Then the panel shows "This file changed on the computer while you were editing"
    And the panel shows the other version "v2 from Pi" next to the member's text
    And the member's text is still in the editor
    When the member chooses Overwrite with mine
    Then the live computer now holds workspace file "plan.md" containing "v2 from Mia"

  @web
  Scenario: The panel warns when Pi changed the open file a moment ago
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the member is editing "/workspace/plan.md"
    When a tool call of the running turn writes "/workspace/plan.md"
    Then the panel shows "Pi changed this a moment ago"
    And the Save button is still available

  @web
  Scenario: The panel warns when the open file changed on the computer without a tool call
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the member is editing "/workspace/plan.md"
    When the file changes on the computer and 5 seconds go by
    Then the panel shows "Pi changed this a moment ago"

  @web
  Scenario: A masked file asks before it is revealed
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the live computer holds workspace file ".env" containing "API_KEY=abc123"
    When the member opens "/workspace/.env"
    Then the panel shows "This file looks like it holds a secret and is not shown"
    And the panel does not contain "abc123"
    When the member chooses Reveal and confirms that it is recorded
    Then the panel shows "API_KEY=abc123"
    And the audit log has a reveal record for the member
    When the member chooses Hide
    Then the panel does not contain "abc123"

  @web
  Scenario: The panel tells the computer it is open and stops when it is hidden
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    When the member opens the Files tab
    Then the panel tells the computer it is open
    And the panel tells the computer again every 15 seconds
    When the member switches to another tab
    Then the panel tells the computer that it is closed
    And the panel stops telling the computer

  @web
  Scenario: A file that is too large to edit offers no editor
    Given the enabled workspace web SPA with a running computer for "ryan@example.com" in "Anthus Labs"
    And the live computer holds a file "/workspace/big.txt" of 300000 bytes
    When the member opens "/workspace/big.txt"
    Then the editor is not offered
    And the panel says the file is too large to edit here

  @web
  Scenario: A member edits a file while the computer is off
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And the saved copy holds workspace file "notes.md" containing "first draft"
    When the member opens "/workspace/notes.md" and chooses Edit
    And the member replaces the text with "second draft" and chooses Save
    Then the panel shows "Saved. Your change will be applied when the computer starts"
    And no computer was started
    When the member opens "/workspace/notes.md"
    Then the panel shows "second draft"

  @web
  Scenario: The panel marks a file that is waiting for the computer
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And a pending edit of "/workspace/notes.md" made while the computer was off
    When the member opens the Files tab
    Then the listing marks "notes.md" as "Edited, waiting for the computer"

  @web
  Scenario: A conflict made while the computer was off shows both versions
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And a pending edit of "/workspace/plan.md" that conflicts with a newer saved version
    When the member opens "/workspace/plan.md"
    Then the panel shows "Your edit conflicts with a newer version of this file"
    And the panel shows the saved version next to the member's text
    When the member chooses Use theirs
    Then the panel shows the saved version only

  @web
  Scenario: An edit made while the computer is starting is tried again
    Given the enabled workspace web SPA with the computer starting for "ryan@example.com" in "Anthus Labs"
    And the next save is answered "computer_starting" with a retry time of 2 seconds
    When the member saves a changed file
    Then the panel shows "The computer is starting; your text is kept"
    And the panel tries to save again after 2 seconds
    And the member's text is still in the editor
    When the clock advances 2 seconds
    Then the panel shows "Saved. Your change will be applied when the computer starts"

  @web
  Scenario: A member deletes a file while the computer is off
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And the saved copy holds workspace file "notes.md" containing "x"
    When the member chooses Delete on "/workspace/notes.md" and confirms
    Then the panel shows "Deleted. This will be applied when the computer starts"
    And the listing no longer shows "notes.md"
    And no computer was started

  @web
  Scenario: A member renames a file and sees it at once
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And the saved copy holds workspace file "old.md" containing "x"
    When the member chooses Rename on "/workspace/old.md" and types "new.md"
    Then the listing shows "new.md" marked "Renamed, waiting for the computer" and not "old.md"

  @web
  Scenario: A member creates a folder
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    When the member chooses New folder and types "docs"
    Then the listing shows the folder "docs" marked "New, waiting for the computer"

  @web
  Scenario: The panel asks before deleting a folder that is not empty and offers it only to the owner role
    Given the enabled workspace web SPA with the computer off for "mia@example.com" who is a member in "Anthus Labs"
    And the saved copy holds a folder "old" with 3 files
    Then the folder "old" offers no recursive delete
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" who is the organization owner in "Anthus Labs"
    And the saved copy holds a folder "old" with 3 files
    When the member chooses Delete on the folder "/workspace/old"
    Then the panel asks "Delete old and the 3 files in it?"
    And the folder is deleted only after the member confirms

  @web
  Scenario: The panel lists the changes waiting for the computer and discards one
    Given the enabled workspace web SPA with the computer off for "ryan@example.com" in "Anthus Labs"
    And pending changes: a delete of "/workspace/a.txt" and a new folder "/workspace/docs"
    When the member opens Pending changes
    Then the panel lists "Deleted a.txt" and "New folder docs"
    When the member discards "Deleted a.txt"
    Then the listing shows "a.txt" again
