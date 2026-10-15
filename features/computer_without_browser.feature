Feature: A computer without a browser
  As a household member
  I want the default computer to be small, with files, git and a terminal, and no browser
  So that a missing browser is a capability the computer reports unavailable, never a boot failure

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And a filesystem snapshot store bound to the host worker
    And tenant "anthus" user "ryan" has computer "household-computer"
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a human task grants:
      | field          | value                                   |
      | tools          | browse, read_workspace, write_workspace |
      | origins        | https://docs.example.com                |
      | recipients     |                                         |
      | file_scopes    | /workspace/research                     |
      | egress_classes | approved_origin_fetch, file_transfer    |
    And a worker registered as:
      | worker_id    | garage-mac-1       |
      | tenant_id    | anthus             |
      | cost_class   | local              |
      | capabilities | computer           |
      | computer_id  | household-computer |

  Scenario: A host without a browser boots and serves a file task
    Given the household computer is stopped
    And the scenario host "garage-mac-1" seeds workspace file "research/notes.txt" containing "weekly"
    When bot "Researcher" is asked "read workspace file /workspace/research/notes.txt"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn is waiting on the workspace capability
    When the computer host boots on an image without a browser
    Then the computer reports the browser capability unavailable and not ready
    And the computer reports the model and workspace capabilities ready
    When a computer-capable pull worker with a workspace executor completes the escalated turn
    Then the active turn journal records a successful read_workspace tool result with content "weekly"

  Scenario: A browse call on a computer without a browser gets a clear message and starts nothing
    Given the computer host has booted on an image without a browser
    And the computer is stopped after that host exits
    When bot "Researcher" is asked "browse https://docs.example.com/page"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the browse tool result says the browser capability is not available on this computer
    And no computer continuation job is queued for the turn
    And no computer action was recorded for the turn
    And the turn is not waiting on the workspace capability

  Scenario: A host with a browser clears the unavailable report
    Given the computer host has booted on an image without a browser
    When the computer host boots with a browser
    Then the computer reports the browser capability ready
