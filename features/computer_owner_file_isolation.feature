Feature: The owner's file tools reach no more than the model's shell reaches
  As an operator of an organization's computer
  I want read_workspace, write_workspace and edit_workspace to run with the unprivileged identity of the shell
  So that a symbolic link planted by a model-chosen command cannot make the credentialed owner read or overwrite what the shell could not

  The owner process holds the organization's scoped cloud credentials and runs as root. The three file tools are carried
  out by a helper process started through the same unprivileged launcher that starts run_terminal, so a link planted in
  the workspace can lead them only where the shell itself could already go. The helper also refuses any path whose final
  location is outside the workspace. The scenarios below plant a file outside the workspace that stands for something only
  the owner could reach, and link to it from inside the workspace.

  Background:
    Given an empty control plane
    And the computer owner has an empty workspace directory
    And a file "owner-only.txt" outside the workspace containing "owner-secret-value"

  Scenario: Reading through a link that leads out of the workspace is refused
    Given the workspace has a symbolic link "leak" to the outside file "owner-only.txt"
    And the model is scripted to call "read_workspace" with:
      """
      {"path": "/workspace/leak"}
      """
    And the model is scripted to answer "Tried."
    When the member asks "read the leak"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the model saw "resolves outside the workspace" in its next request
    And the model's next request does not contain "owner-secret-value"

  Scenario: Writing through a link that leads out of the workspace is refused and changes nothing
    Given the workspace has a symbolic link "leak" to the outside file "owner-only.txt"
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/leak", "content": "overwritten"}
      """
    And the model is scripted to answer "Tried."
    When the member asks "overwrite the leak"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the model saw "resolves outside the workspace" in its next request
    And the outside file "owner-only.txt" still contains "owner-secret-value"

  Scenario: Editing through a link that leads out of the workspace is refused and changes nothing
    Given the workspace has a symbolic link "leak" to the outside file "owner-only.txt"
    And the model is scripted to call "edit_workspace" with:
      """
      {"path": "/workspace/leak", "old_text": "owner-secret-value", "new_text": "changed"}
      """
    And the model is scripted to answer "Tried."
    When the member asks "edit the leak"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the model saw "resolves outside the workspace" in its next request
    And the outside file "owner-only.txt" still contains "owner-secret-value"

  Scenario: Writing a new file under a link to an outside directory is refused and creates nothing there
    Given the workspace has a symbolic link "outside-directory" to the outside directory
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/outside-directory/planted.txt", "content": "planted"}
      """
    And the model is scripted to answer "Tried."
    When the member asks "write under the directory link"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the model saw "resolves outside the workspace" in its next request
    And the outside directory has no file "planted.txt"

  Scenario: Writing through a link whose target does not exist yet is refused and creates nothing there
    Given the workspace has a symbolic link "dangling" to the outside file "created-by-owner.txt"
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/dangling", "content": "planted"}
      """
    And the model is scripted to answer "Tried."
    When the member asks "write through the dangling link"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the model saw "resolves outside the workspace" in its next request
    And the outside directory has no file "created-by-owner.txt"

  Scenario: A path that climbs out of the workspace with dot-dot is refused before any file is touched
    Given the model is scripted to call "read_workspace" with:
      """
      {"path": "/workspace/../outside/owner-only.txt"}
      """
    And the model is scripted to answer "Tried."
    When the member asks "read outside with dot-dot"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the model saw "is outside the workspace" in its next request
    And the model's next request does not contain "owner-secret-value"

  Scenario: A link between two places inside the workspace is followed as usual
    Given the workspace has a file "real/notes.txt" containing "inside-content"
    And the workspace has a symbolic link "alias.txt" to the workspace path "real/notes.txt"
    And the model is scripted to call "read_workspace" with:
      """
      {"path": "/workspace/alias.txt"}
      """
    And the model is scripted to answer "Read it."
    When the member asks "read the alias"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the model saw "inside-content" in its next request

  Scenario: Ordinary files are written and edited with the same results as before
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/deep/er/notes.md", "content": "alpha beta"}
      """
    And the model is scripted to call "edit_workspace" with:
      """
      {"path": "/workspace/deep/er/notes.md", "old_text": "beta", "new_text": "gamma"}
      """
    And the model is scripted to call "edit_workspace" with:
      """
      {"path": "/workspace/deep/er/notes.md", "old_text": "omega", "new_text": "zeta"}
      """
    And the model is scripted to answer "Done."
    When the member asks "write and edit the notes"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the workspace file "deep/er/notes.md" contains "alpha gamma"
    And the model saw "Could not find the exact text" in its next request

  Scenario: File tools run through the launcher the shell runs through
    Given an unprivileged shell launcher that records every command it starts
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "draft-one"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the workspace file "notes.md" contains "draft-one"
    And the shell launcher started at least 1 command
