Feature: Rich turn events
  As a member watching a bot work
  I want the turn's events to say what the bot is doing, with what, and how it went
  So that the page can show readable activity and the audit can see the arguments and results of every tool

  Background:
    Given an empty control plane
    And the computer owner has an empty workspace directory

  Scenario: A terminal command is described by its call and its result
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo hello-from-the-computer", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Done."
    When the member asks "say hello"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the journal has a tool call "run_terminal" summarized "Running: echo hello-from-the-computer"
    And the arguments of the tool call "run_terminal" are:
      """
      {"command": "echo hello-from-the-computer"}
      """
    And the tool call "run_terminal" says its arguments were not truncated
    And the tool result of "run_terminal" is ok and summarized "Exit 0"
    And the tool result output of "run_terminal" contains "hello-from-the-computer"
    And the tool result of "run_terminal" has a duration in milliseconds
    And the tool call and the tool result of "run_terminal" share one call id

  Scenario: A failing command is a failed result
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo it-broke; exit 1", "cwd": "/workspace"}
      """
    And the model is scripted to answer "That failed."
    When the member asks "run the broken command"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the tool result of "run_terminal" is not ok and summarized "Exit 1"
    And the tool result output of "run_terminal" contains "it-broke"

  Scenario: A long command is cut in its arguments and its summary
    Given the model is scripted to call "run_terminal" with a command of 1500 characters
    And the model is scripted to answer "Done."
    When the member asks "run the long command"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the command argument of the tool call "run_terminal" is 1000 characters long
    And the tool call "run_terminal" says its arguments were truncated
    And the summary of the tool call "run_terminal" is at most 89 characters long

  Scenario: A file write is described by its size and a preview
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "draft-one"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the journal has a tool call "write_workspace" summarized "Writing /workspace/notes.md (9 bytes)"
    And the arguments of the tool call "write_workspace" are:
      """
      {"path": "/workspace/notes.md", "bytes": 9, "preview": "draft-one"}
      """
    And the tool result of "write_workspace" is ok and summarized "Wrote 9 bytes"

  Scenario: A file edit is described by the text it replaces
    Given the workspace has a file "notes.md" containing "draft-one"
    And the model is scripted to call "edit_workspace" with:
      """
      {"path": "/workspace/notes.md", "old_text": "draft-one", "new_text": "draft-two"}
      """
    And the model is scripted to answer "Edited."
    When the member asks "fix the notes"
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the journal has a tool call "edit_workspace" summarized "Editing /workspace/notes.md"
    And the arguments of the tool call "edit_workspace" are:
      """
      {"path": "/workspace/notes.md", "old_text": "draft-one", "new_text": "draft-two"}
      """
    And the tool result of "edit_workspace" is ok and summarized "Edited 1 block"

  Scenario: An oversized output keeps its head and its tail
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "head -c 5000 /dev/zero | tr '\\0' 'x'", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Done."
    When the member asks "print a lot"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the tool result of "run_terminal" is marked as truncated
    And the tool result output of "run_terminal" keeps 1500 characters at each end around an omission marker

  Scenario: A secret of the process never reaches an event
    Given the owner process holds the secret environment variables "CHATTICUS_MODEL_GATEWAY_TOKEN"
    And the model is scripted to call "run_terminal" with the secret value of "CHATTICUS_MODEL_GATEWAY_TOKEN" in an echo command
    And the model is scripted to answer "Done."
    When the member asks "echo the token"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And no event of the journal contains the value of "CHATTICUS_MODEL_GATEWAY_TOKEN"
    And the tool result output of "run_terminal" contains "[redacted]"
    And the arguments of the tool call "run_terminal" contain "[redacted]"

  Scenario: A call replayed by a later owner is journaled once
    Given the model is scripted to call "read_workspace" with:
      """
      {"path": "/workspace/notes.md"}
      """
    And the model is scripted to answer "Read it."
    And the workspace has a file "notes.md" containing "seed-text"
    When the member asks "read the notes"
    And a Lambda-style owner works the turn until it parks
    And computer owner "first" takes over the turn and is held after its tool ran
    And the clock moves past the turn lease
    And computer owner "second" takes over the turn
    And held computer owner "first" is released
    Then the takeover of "second" ended "done"
    And every call id of the journal has exactly one tool.call and one tool.result

  Scenario: A reasoning summary is coalesced rather than sent per delta
    Given the model reasons in 60 pieces of 5 characters before answering "All done."
    When the member asks "think about it"
    And a Lambda-style owner works the turn to its end
    Then the journal has fewer than 12 turn.thinking events
    And the turn.thinking events join to the first 300 characters of the reasoning
    And the turn.thinking events come before the first turn.token

  Scenario: A reasoning summary is capped for the turn
    Given the model reasons in 10 pieces of 300 characters before answering "All done."
    When the member asks "think about it at length"
    And a Lambda-style owner works the turn to its end
    Then the turn.thinking events join to the first 2000 characters of the reasoning

  Scenario: A model with no reasoning summary emits no thinking events
    Given the model is scripted to answer "Plain."
    When the member asks "just answer"
    And a Lambda-style owner works the turn to its end
    Then the journal has no turn.thinking events

  Scenario: Parking for the computer and resuming on it are announced
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "draft-one"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the journal kinds contain in order "tool.call, computer.starting, turn.waiting, attempt.claimed, computer.ready, tool.result"
    And the journal event "computer.starting" says "Starting your computer"
    And the journal event "computer.ready" says "Computer ready"
    And the journal has exactly one computer.starting and one computer.ready event

  Scenario: A turn that never needs the computer announces nothing about it
    Given the model is scripted to answer "No computer needed."
    When the member asks "just talk"
    And a Lambda-style owner works the turn to its end
    Then the journal has no computer.starting or computer.ready events
