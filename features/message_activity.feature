Feature: A listed bot message carries the tool activity of its turn
  As a member reading a channel's history
  I want each bot answer to show what the bot did to produce it
  So that the tool cards I saw live are still there after a reload, drawn from the permanent session

  Background:
    Given an empty control plane
    And the computer owner has an empty workspace directory

  Scenario: A terminal command is listed with its arguments, outcome and output
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo hello-from-the-computer", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Done."
    When the member asks "say hello"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    And the human opens the message list of the channel
    Then the listed bot message reads "Done."
    And the listed bot message has 1 activity items
    And activity item 1 is the tool "run_terminal" summarized "Running: echo hello-from-the-computer"
    And the arguments of activity item 1 are:
      """
      {"command": "echo hello-from-the-computer"}
      """
    And activity item 1 says its arguments were not truncated
    And activity item 1 is ok with the result summary "Exit 0"
    And the output of activity item 1 contains "hello-from-the-computer"
    And activity item 1 says its output was not truncated
    And activity item 1 has no duration
    And the message list wrote nothing to the session store or its bucket

  Scenario: A failing command is listed as failed
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo it-broke; exit 1", "cwd": "/workspace"}
      """
    And the model is scripted to answer "That failed."
    When the member asks "run the broken command"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    And the human opens the message list of the channel
    Then activity item 1 is not ok with the result summary "Exit 1"
    And the output of activity item 1 contains "it-broke"

  Scenario: A long output is listed with its head and its tail
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "head -c 5000 /dev/zero | tr '\\0' 'x'", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Done."
    When the member asks "print a lot"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    And the human opens the message list of the channel
    Then activity item 1 says its output was truncated
    And the output of activity item 1 keeps 1500 characters at each end around an omission marker

  Scenario: A file write is listed by its path, size and preview, not by its content
    Given the model is scripted to write "/workspace/notes.md" with 600 characters of content
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    And computer owner "container" takes over the turn
    And the human opens the message list of the channel
    Then activity item 1 is the tool "write_workspace" summarized "Writing /workspace/notes.md (600 bytes)"
    And activity item 1 has a path, 600 bytes and a preview of 200 characters but no content
    And activity item 1 says its arguments were truncated
    And activity item 1 is ok with the result summary "Wrote 600 bytes"

  Scenario: Two tool calls of one turn are listed in the order they were made
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo first-call", "cwd": "/workspace"}
      """
    And the model is scripted to call "run_terminal" with:
      """
      {"command": "echo second-call", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Both ran."
    When the member asks "run two commands"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    And the human opens the message list of the channel
    Then the listed bot message reads "Both ran."
    And the listed bot message has 2 activity items
    And activity item 1 is the tool "run_terminal" summarized "Running: echo first-call"
    And activity item 2 is the tool "run_terminal" summarized "Running: echo second-call"
    And the output of activity item 2 contains "second-call"

  Scenario: A turn without tools has no activity field
    Given the model is scripted to answer "No tools needed."
    When the member asks "just talk"
    And a Lambda-style owner works the turn to its end
    And the human opens the message list of the channel
    Then the listed bot message reads "No tools needed."
    And the listed bot message has no activity field
    And the listed human message has no activity field

  Scenario: A secret of the process is scrubbed from the listed activity
    Given the owner process holds the secret environment variables "CHATTICUS_MODEL_GATEWAY_TOKEN"
    And the model is scripted to call "run_terminal" with the secret value of "CHATTICUS_MODEL_GATEWAY_TOKEN" in an echo command
    And the model is scripted to answer "Done."
    When the member asks "echo the token"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    And the human opens the message list of the channel
    Then the message list does not contain the value of "CHATTICUS_MODEL_GATEWAY_TOKEN"
    And the output of activity item 1 contains "[redacted]"
    And the arguments of activity item 1 contain "[redacted]"

  Scenario: More than 50 tool calls are capped with a final item that counts the rest
    Given the model is scripted to call "run_terminal" 52 times in one step
    And the model is scripted to answer "That was a lot."
    When the member asks "run many commands"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over a long turn
    And the human opens the message list of the channel
    Then the listed bot message has 50 activity items
    And activity item 1 is the tool "run_terminal" summarized "Running: echo call-1"
    And activity item 49 is the tool "run_terminal" summarized "Running: echo call-49"
    And activity item 50 is the tool "more" summarized "3 more tool calls"

  Scenario: The listed activity says the same as the live events of the turn
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo same-as-live", "cwd": "/workspace"}
      """
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "draft-one"}
      """
    And the model is scripted to answer "Done."
    When the member asks "do both"
    And the member allows the turn tools "run_terminal, write_workspace" under "/workspace"
    And a Lambda-style owner works the turn until it parks
    And computer owner "container" takes over the turn
    And the human opens the message list of the channel
    Then every activity item of the listed bot message equals the live events of the same call
