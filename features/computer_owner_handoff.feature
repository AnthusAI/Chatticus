Feature: Computer owner handoff
  As a member of an organization
  I want a turn to be taken over by a process inside the organization's computer and handed back afterwards
  So that the bot works with the computer's own tools and the same conversation continues on any owner

  Background:
    Given an empty control plane
    And the computer owner has an empty workspace directory

  Scenario: A Lambda-style owner still parks the turn on a computer tool and runs nothing itself
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "draft-one"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    Then the turn is waiting on the workspace gate
    And the turn names the pending computer tool "write_workspace"
    And the workspace has no file "notes.md"
    And the turn has one computer action and it is not done

  Scenario: A computer owner takes over a parked turn and finishes it with local tools
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "draft-one"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the workspace file "notes.md" contains "draft-one"
    And the turn is completed
    And the turn has one computer action and it is done
    And the computer action was claimed by "computer-owner-container"
    And the model saw "Successfully wrote to /workspace/notes.md" in its next request
    And no run job is queued for the turn

  Scenario: A session handed back to a Lambda-style owner carries the results of the computer
    Given the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "draft-one"}
      """
    And the model is scripted to answer "Notes saved."
    And the model is scripted to answer "I wrote the notes file."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    And computer owner "container" takes over the turn
    And the member sends "what did you just do?" in the same channel
    And a Lambda-style owner works the turn to its end
    Then the takeover of "container" ended "done"
    And the model saw "Successfully wrote to /workspace/notes.md" in its next request
    And the storage fence of the second turn is higher than that of the first turn

  Scenario: A crash in the middle of a local command does not run the command again
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo started >> runs.log", "cwd": "/workspace"}
      """
    And the model is scripted to answer "I could not confirm that the command finished."
    When the member asks "append a line to the run log"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And a Lambda-style owner works the turn until it parks
    And computer owner "first" takes over the turn and is held after its tool ran
    And the clock moves past the turn lease
    And computer owner "second" takes over the turn
    And held computer owner "first" is released
    Then the takeover of "second" ended "done"
    And the takeover of "first" ended "lost"
    And the workspace file "runs.log" has exactly 1 line
    And the turn has one computer action and it is done
    And the computer action ended in an error containing "interrupted"
    And the model saw "interrupted" in its next request

  Scenario: A call that only reads is run again after a crash
    Given the workspace has a file "notes.md" containing "seed-text"
    And the model is scripted to call "read_workspace" with:
      """
      {"path": "/workspace/notes.md"}
      """
    And the model is scripted to answer "I read the notes."
    When the member asks "read the notes"
    And a Lambda-style owner works the turn until it parks
    And computer owner "first" takes over the turn and is held after its tool ran
    And the clock moves past the turn lease
    And computer owner "second" takes over the turn
    And held computer owner "first" is released
    Then the takeover of "second" ended "done"
    And the turn has one computer action and it is done
    And the computer action was claimed by "computer-owner-second"
    And the model saw "seed-text" in its next request

  Scenario: Of two owners that find the turn at the same time exactly one runs it
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo started >> runs.log", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Done."
    When the member asks "append a line to the run log"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And a Lambda-style owner works the turn until it parks
    And computer owners "left" and "right" take over the turn at the same moment
    Then exactly one of the takeovers ended "done" and the other ended "lost"
    And the workspace file "runs.log" has exactly 1 line
    And the turn has one computer action and it is done
    And the turn took exactly 2 attempts
    And the model was asked 2 times

  Scenario: An owner that arrives while another owner holds the turn stops and changes nothing
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo started >> runs.log", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Done."
    When the member asks "append a line to the run log"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And a Lambda-style owner works the turn until it parks
    And computer owner "winner" takes over the turn and is held after its tool ran
    And computer owner "loser" takes over the turn
    Then the takeover of "loser" ended "lost"
    And the model was asked 1 time
    And the turn has one computer action and it is not done
    When held computer owner "winner" is released
    Then the takeover of "winner" ended "done"
    And the workspace file "runs.log" has exactly 1 line
    And the turn has one computer action and it is done
    And the computer action was claimed by "computer-owner-winner"
    And the turn took exactly 2 attempts

  Scenario: The grant gate denies a path outside the grant in the computer owner as it does in a Lambda owner
    Given the model is scripted to call "read_workspace" with:
      """
      {"path": "/etc/hostname"}
      """
    And the model is scripted to answer "That was refused."
    And the model is scripted to call "read_workspace" with:
      """
      {"path": "/etc/hostname"}
      """
    And the model is scripted to answer "That was refused."
    When the member asks "read the host name"
    And a Lambda-style owner works the turn to its end
    And the member sends "read the host name again" in the same channel
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the tool results of the first and second turn are identical
    And the tool result of the second turn contains "Tool call blocked:"
    And the turn has no computer action

  Scenario Outline: A computer owner marks the disk dirty exactly as the host path does
    Given the workspace has a file "notes.md" containing "seed-text"
    And the model is scripted to call "<tool>" with:
      """
      <arguments>
      """
    And the model is scripted to answer "Finished."
    When the member asks "use the computer"
    And the member allows the turn tools "read_workspace, write_workspace, edit_workspace, run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the turn has one computer action and it is done
    And the computer's disk is <dirtiness>

    Examples:
      | tool            | arguments                                                    | dirtiness     |
      | read_workspace  | {"path": "/workspace/notes.md"}                              | not dirty     |
      | write_workspace | {"path": "/workspace/notes.md", "content": "changed"}        | marked dirty  |
      | edit_workspace  | {"path": "/workspace/notes.md", "old_text": "seed", "new_text": "new"} | marked dirty |
      | run_terminal    | {"command": "echo changed > other.md", "cwd": "/workspace"}  | marked dirty  |

  Scenario: A computer owner changes part of a file with the edit tool
    Given the workspace has a file "notes.md" containing "draft-one and more"
    And the model is scripted to call "edit_workspace" with:
      """
      {"path": "/workspace/notes.md", "old_text": "draft-one", "new_text": "draft-two"}
      """
    And the model is scripted to answer "Edited."
    When the member asks "fix the draft"
    And a Lambda-style owner works the turn until it parks
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the workspace file "notes.md" contains "draft-two and more"
    And the turn has one computer action and it is done
    And the computer's disk is marked dirty

  Scenario: A command run by the computer owner does not see the owner's secrets
    Given the owner process holds the secret environment variables "OPENAI_API_KEY, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN"
    And the model is scripted to call "run_terminal" with:
      """
      {"command": "env", "cwd": "/workspace"}
      """
    And the model is scripted to answer "Here is the environment."
    When the member asks "show me your environment"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the model saw "HOME=" in its next request
    And the model's next request does not contain the value of "OPENAI_API_KEY"
    And the model's next request does not contain the value of "AWS_SECRET_ACCESS_KEY"
    And the model's next request does not contain the value of "AWS_SESSION_TOKEN"
    And the model's next request does not contain the name "OPENAI_API_KEY"

  Scenario: A command cannot start outside the workspace
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "pwd", "cwd": "/workspace/../etc"}
      """
    And the model is scripted to answer "That was refused."
    When the member asks "look around"
    And the member allows the turn tools "run_terminal" under "/"
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the model saw "is outside the workspace" in its next request

  Scenario: A computer owner leaves a finished turn alone
    Given the model is scripted to answer "Hello."
    When the member asks "say hello"
    And a Lambda-style owner works the turn to its end
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "already_finished"
    And the model was asked 1 time
    And the turn has no computer action

  Scenario: A computer owner leaves a turn that does not exist alone
    When computer owner "container" takes over a turn that does not exist
    Then the takeover of "container" ended "not_found"
