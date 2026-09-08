Feature: A bot can run a granted shell command on the household computer
  As a household member
  I want a bot to run shell commands on the summoned host when explicitly granted
  So that workspace inspection does not require pretending files are unreadable

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And a filesystem snapshot store bound to the host worker
    And tenant "anthus" user "ryan" has computer "household-computer"
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a worker registered as:
      | worker_id   | garage-mac-1       |
      | tenant_id   | anthus             |
      | cost_class  | local              |
      | capabilities| computer,browser,terminal |
      | computer_id | household-computer |

  Scenario: Granted command appears in the turn journal
    Given a bot with a terminal grant on the household computer
    And the household computer is stopped
    And the scenario host "garage-mac-1" seeds workspace file "marker.txt" containing "host-marker"
    When a human asks the bot to run command "cat marker.txt" using cwd "/workspace"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn is waiting on the workspace capability
    And a computer continuation job is queued for the turn
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a terminal executor completes the escalated turn
    Then the turn journal contains the command output from the host
    And the bot does not only reply that it cannot run shell commands

  Scenario: Terminal grant denial does not start the host
    Given the household computer is stopped
    When a human asks the bot to run command "ls /workspace" using cwd "/workspace"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn journal records a denied run_terminal tool result
    And no computer continuation job is queued for the turn
    And the turn is not waiting on the workspace capability
    And the household computer is stopped

  Scenario: A stopped computer waiting on run_terminal waits on the workspace gate
    Given a bot with a terminal grant on the household computer
    And the household computer is stopped
    And the scenario host "garage-mac-1" seeds workspace file "marker.txt" containing "host-marker"
    When a human asks the bot to run command "cat marker.txt" using cwd "/workspace"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn is waiting on the workspace capability
    And a computer continuation job is queued for the turn

  Scenario: The host executor runs ls and commits stdout to the journal
    Given a bot with a terminal grant on the household computer
    And the scenario host "garage-mac-1" seeds workspace file "marker.txt" containing "host-marker"
    And a fenced run_terminal handoff with a queued continuation job for command "ls" using cwd "/workspace"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a terminal executor pulls that continuation job
    Then the turn journal records a successful run_terminal tool result containing "marker.txt"
    And the pull worker leaves no unresolved tool calls

  Scenario: cwd outside file_scopes is denied before host start
    Given a human task grants:
      | field          | value         |
      | tools          | run_terminal  |
      | origins        |               |
      | recipients     |               |
      | file_scopes    | /workspace/research |
      | egress_classes |               |
    And the household computer is stopped
    When a human asks the bot to run command "ls /workspace" using cwd "/workspace" in cwd "/workspace"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn journal records a denied run_terminal tool result
    And no computer continuation job is queued for the turn

  Scenario: Path escape in cwd is rejected on the host
    Given a bot with a terminal grant on the household computer
    And a fenced run_terminal handoff with a queued continuation job for command "ls ." using cwd "/workspace/research/../../../../../etc"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a terminal executor pulls that continuation job
    Then the turn journal records a run_terminal tool result containing "error:"

  Scenario: A tampered continuation job is re-gated before execute
    Given a bot with a terminal grant on the household computer
    And a human task grants:
      | field          | value              |
      | tools          | run_terminal       |
      | origins        |                    |
      | recipients     |                    |
      | file_scopes    | /workspace/research |
      | egress_classes |                    |
    And the scenario host "garage-mac-1" seeds workspace file "private/secret.txt" containing "top secret"
    And a fenced run_terminal handoff with a tampered queued continuation job for command "cat secret.txt" using cwd "/workspace/private"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a terminal executor pulls that continuation job
    Then the turn journal records a denied run_terminal tool result
    And host "garage-mac-1" has workspace file "private/secret.txt" containing "top secret"

  Scenario: Terminal work does not require the browser gate
    Given a bot with a terminal grant on the household computer
    And a fenced run_terminal handoff with a queued continuation job for command "ls" using cwd "/workspace"
    When the computer host has booted through the workspace gate
    Then browser readiness is not recorded until the browser gate clears
    When a computer-capable pull worker with a terminal executor pulls that continuation job
    Then the turn journal records a successful run_terminal tool result containing "run_terminal:exit=0"
