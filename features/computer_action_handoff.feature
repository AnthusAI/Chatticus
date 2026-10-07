Feature: Computer action handoff
  As a member of an organization
  I want a bot that needs the computer to wait for it without losing its turn
  So that each computer tool call runs once on the shared computer and the bot continues from its result

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"

  Scenario: A computer tool call parks the turn and records one action
    When bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    Then the turn is waiting on the workspace gate
    And the turn names the pending computer tool "write_workspace"
    And the computer has one open action for "write_workspace"
    And no turn owner holds the turn
    And the turn journal shows the tool call before the waiting event
    And a computer start job is queued for the turn

  Scenario: The host's result resumes the turn and the tool runs once
    Given host worker "garage-mac-1" serves the household computer
    And bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    When host worker "garage-mac-1" runs the next computer action
    And bot "Researcher" works its turn after the computer answered
    Then the turn is completed
    And the host executed "write_workspace" exactly once
    And the turn journal records one tool result containing "wrote /workspace/notes.md"
    And the model saw "wrote /workspace/notes.md" in its next request
    And the turn has one computer action and it is done

  Scenario: A live host is not asked to start
    Given host worker "garage-mac-1" serves the household computer
    When bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    Then no computer start job is queued

  Scenario: A host that exited cleanly is not counted as live while its last heartbeat is still recent
    Given host worker "garage-mac-1" serves the household computer
    And host worker "garage-mac-1" reports the computer stopped as it exits
    And 15 seconds pass
    When bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    Then a computer start job is queued for the turn

  Scenario: A running host with a recent heartbeat is not asked to start
    Given host worker "garage-mac-1" serves the household computer
    And 15 seconds pass
    When bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    Then no computer start job is queued

  Scenario: A host that is still starting is started only once however many start jobs arrive
    Given a recording host start driver
    And host worker "booting-host" serves the household computer
    And host worker "booting-host" reports the computer stopped as it exits
    When bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    And the queued start job is delivered to the starter together with a second start job for the same computer
    Then the host start driver was invoked once

  Scenario: An organization that allows only AWS hosts is not served by a live local host
    Given the household computer policy is "aws_only"
    And host worker "garage-mac-1" serves the household computer
    When bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    Then a computer start job is queued for the turn with policy "aws_only"

  Scenario: The same result posted twice resumes the turn once
    Given host worker "garage-mac-1" serves the household computer
    And bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    When host worker "garage-mac-1" runs the next computer action
    And host worker "garage-mac-1" posts that result again
    Then exactly one run job is queued for the turn

  Scenario: A turn resumed before the host answers parks again on the same action
    Given host worker "garage-mac-1" serves the household computer
    And bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    When user "ryan" of tenant "anthus" resumes that waiting turn
    And bot "Researcher" works its turn until it waits for the computer
    Then the turn is waiting on the workspace gate
    And the turn has one computer action and it is not done

  Scenario: A waiting turn delivered to an executor again does not ask the model again
    When bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    And the run job of that turn is delivered again
    Then the executor leaves the redelivered run job alone
    And the model was asked once
    And the turn is waiting on the workspace gate
    And the turn has one computer action and it is not done

  Scenario: A crash after parking and before the start job still gets the computer started
    When bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And the worker stops right after the turn parks and before the start job is queued
    And 61 seconds pass
    And the turn probe runs
    Then a computer start job is queued for the turn
    And the turn is waiting on the workspace gate

  Scenario: A host lost while running a write does not run it again
    Given host worker "garage-mac-1" serves the household computer
    And bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    When host worker "garage-mac-1" runs the next computer action but is lost before it posts the result
    And 61 seconds pass
    And the turn probe runs
    And bot "Researcher" works its turn after the computer answered
    Then the turn is completed
    And the host executed "write_workspace" exactly once
    And the model saw "may have partially run" in its next request

  Scenario: A host lost while running a read hands the read to the next claim
    Given host worker "garage-mac-1" serves the household computer
    And the computer holds the file "/workspace/notes.md" containing "draft-one"
    And bot "Researcher" is asked "read workspace file /workspace/notes.md"
    And bot "Researcher" works its turn until it waits for the computer
    When host worker "garage-mac-1" runs the next computer action but is lost before it posts the result
    And 61 seconds pass
    And the turn probe runs
    And host worker "garage-mac-1" runs the next computer action
    And bot "Researcher" works its turn after the computer answered
    Then the turn is completed
    And the turn journal records one tool result containing "draft-one"

  Scenario: A parked turn that no host claims asks for a host start again
    When bot "Researcher" is asked "write workspace file /workspace/notes.md containing draft-one"
    And bot "Researcher" works its turn until it waits for the computer
    And 61 seconds pass
    And the turn probe runs
    Then another computer start job is queued for the turn
