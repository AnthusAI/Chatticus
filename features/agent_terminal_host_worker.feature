Feature: A granted shell command on the household computer that waits for the host worker
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
