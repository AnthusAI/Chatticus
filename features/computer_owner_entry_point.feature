Feature: Computer owner entry point
  As an operator of an organization's computer
  I want the computer's own program to claim a takeover job and run the turn with the shell kept away from its secrets
  So that the bot works on the computer's disk without model-chosen commands reaching the owner's credentials

  Background:
    Given an empty control plane
    And the computer owner has an empty workspace directory

  Scenario: The computer entry point claims a takeover job and runs the turn as the container-side owner
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "draft-one"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the workspace file "notes.md" contains "draft-one"
    And the turn is completed
    And the computer action was claimed by "computer-host-owner"
    And no run job is queued for the turn

  Scenario: The computer entry point with no takeover job does nothing
    When no takeover job is waiting
    And the computer entry point runs
    Then the entry point ended "no_job"
    And the model was asked 0 times

  Scenario: The entry point reports a takeover job for a turn that does not exist and changes nothing
    When a takeover job names a turn that does not exist
    And the computer entry point runs
    Then the entry point ended "not_found"

  Scenario: A command run through the entry point does not see the secrets the owner holds
    Given the owner process holds the secret environment variables "OPENAI_API_KEY, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, CHATTICUS_MODEL_GATEWAY_TOKEN, CHATTICUS_INVOKE_KEY"
    And the model is scripted to call "run_terminal" with:
      """
      {"command": "env", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Here is the environment."
    When the member asks "show me your environment"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the model saw "HOME=" in its next request
    And the model's next request does not contain the value of "OPENAI_API_KEY"
    And the model's next request does not contain the value of "AWS_SECRET_ACCESS_KEY"
    And the model's next request does not contain the value of "AWS_SESSION_TOKEN"
    And the model's next request does not contain the value of "CHATTICUS_MODEL_GATEWAY_TOKEN"
    And the model's next request does not contain the value of "CHATTICUS_INVOKE_KEY"

  Scenario: Commands run through the configured unprivileged shell launcher
    Given an unprivileged shell launcher that records every command it starts
    And the model is scripted to call "run_terminal" with:
      """
      {"command": "echo launched-ok", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Done."
    When the member asks "say something from the shell"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And a takeover job names the turn
    And the computer entry point runs
    Then the entry point ended "done"
    And the shell launcher started exactly 1 command
    And the model saw "launched-ok" in its next request

  Scenario: Files are read and written by the owner itself and never through the shell launcher
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
    And the shell launcher started exactly 0 commands

  Scenario: An entry point whose shell launcher is missing refuses to take the turn
    Given the entry point is configured with a shell launcher that does not exist
    And the model is scripted to answer "Hello."
    When the member asks "say hello"
    And a takeover job names the turn
    And the computer entry point is run and refused
    Then the refusal mentions "shell launcher"
    And the model was asked 0 times
    And the turn is still active with no attempt taken
