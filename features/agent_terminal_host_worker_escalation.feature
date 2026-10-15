Feature: A granted shell command escalates to the household computer host worker
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

  Scenario: A stopped computer waiting on run_terminal waits on the workspace gate
    Given a bot with a terminal grant on the household computer
    And the household computer is stopped
    And the scenario host "garage-mac-1" seeds workspace file "marker.txt" containing "host-marker"
    When a human asks the bot to run command "cat marker.txt" using cwd "/workspace"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn is waiting on the workspace capability
    And a computer continuation job is queued for the turn
