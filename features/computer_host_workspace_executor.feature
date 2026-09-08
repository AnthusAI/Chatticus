Feature: Workspace file tools on the computer host
  As a household member
  I want read_workspace and write_workspace to run on the summoned host
  So that agent file I/O never reads the control-plane workspace dict

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And a filesystem snapshot store bound to the host worker
    And tenant "anthus" user "ryan" has computer "household-computer"
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a human task grants:
      | field          | value                              |
      | tools          | browse, read_workspace, write_workspace |
      | origins        | https://docs.example.com           |
      | recipients     |                                    |
      | file_scopes    | /workspace/research                |
      | egress_classes | approved_origin_fetch, file_transfer |
    And a worker registered as:
      | worker_id   | garage-mac-1       |
      | tenant_id   | anthus             |
      | cost_class  | local              |
      | capabilities| computer,browser   |
      | computer_id | household-computer |

  Scenario: The host reads a granted workspace file after the workspace gate
    Given the scenario host "garage-mac-1" seeds workspace file "research/notes.txt" containing "weekly"
    And a fenced workspace read handoff with a queued continuation job for "/workspace/research/notes.txt"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records a successful read_workspace tool result with content "weekly"
    And the pull worker leaves no unresolved tool calls

  Scenario: The host writes a granted workspace file on live disk
    Given a fenced workspace write handoff with a queued continuation job for "/workspace/research/draft.txt" containing "hello"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records a successful write_workspace tool result
    And host "garage-mac-1" has workspace file "research/draft.txt" containing "hello"

  Scenario: A computerless turn escalates read_workspace when the computer is stopped
    Given the household computer is stopped
    And the scenario host "garage-mac-1" seeds workspace file "research/notes.txt" containing "weekly"
    When bot "Researcher" is asked "read workspace file /workspace/research/notes.txt"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn is waiting on the workspace capability
    And a computer continuation job is queued for the turn
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor completes the escalated turn
    Then the active turn journal records a successful read_workspace tool result with content "weekly"

  Scenario: Grant denial does not start the host for read_workspace
    Given the household computer is stopped
    When bot "Researcher" is asked "read workspace file /workspace/private/secret.txt"
    And bot "Researcher" runs one capability-aware computerless worker turn
    Then the turn journal records a denied read_workspace tool result
    And the household computer is stopped

  Scenario: Read after relocate uses hydrated host bytes
    Given a worker registered as:
      | worker_id   | fargate-1          |
      | tenant_id   | anthus             |
      | cost_class  | fargate            |
      | capabilities| computer,browser   |
      | computer_id | household-computer |
    And worker "fargate-1" has published computer "household-computer" with workspace file "research/notes.txt" containing "weekly account list"
    When an administrator relocates computer "household-computer" to worker "garage-mac-1"
    Given a fenced workspace read handoff with a queued continuation job for "/workspace/research/notes.txt"
    When the customer computer host "garage-mac-1" boots through the Front Door worker plane
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records a successful read_workspace tool result with content "weekly account list"
    And computer "household-computer" does not require hydrate

  Scenario: Missing file returns a not-found tool result
    Given a fenced workspace read handoff with a queued continuation job for "/workspace/research/missing.txt"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records a read_workspace tool result containing "not found"

  Scenario: Path escape is rejected on the host
    Given a fenced workspace read handoff with a queued continuation job for "/workspace/research/notes/../../../../../etc/passwd"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records a read_workspace tool result containing "error:"

  Scenario: File tools work when no snapshot store is configured
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has computer "household-computer"
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a human task grants:
      | field          | value                              |
      | tools          | read_workspace, write_workspace    |
      | origins        |                                    |
      | recipients     |                                    |
      | file_scopes    | /workspace/research                |
      | egress_classes | file_transfer                      |
    And a worker registered as:
      | worker_id   | garage-mac-1       |
      | tenant_id   | anthus             |
      | cost_class  | local              |
      | capabilities| computer,browser   |
      | computer_id | household-computer |
    And a fenced workspace write handoff with a queued continuation job for "/workspace/research/live.txt" containing "live bytes"
    When the customer computer host "garage-mac-1" boots without a snapshot store
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then host "garage-mac-1" has workspace file "research/live.txt" containing "live bytes"
    And the Front Door received no snapshot hydrate or publish requests
