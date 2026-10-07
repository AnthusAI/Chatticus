Feature: Workspace edits on the computer host
  As a household member
  I want a bot to change one exact piece of an existing workspace file
  So that a small change does not rewrite the whole file

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And a filesystem snapshot store bound to the host worker
    And tenant "anthus" user "ryan" has computer "household-computer"
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a worker registered as:
      | worker_id   | garage-mac-1       |
      | tenant_id   | anthus             |
      | cost_class  | local              |
      | capabilities| computer,browser   |
      | computer_id | household-computer |

  Scenario: The host replaces the one occurrence of the old text
    Given the scenario host "garage-mac-1" seeds workspace file "research/notes.txt" containing "alpha beta gamma"
    And a fenced workspace edit handoff with a queued continuation job for "/workspace/research/notes.txt" replacing "beta" with "delta"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records a successful edit_workspace tool result
    And host "garage-mac-1" has workspace file "research/notes.txt" containing "alpha delta gamma"
    And the pull worker leaves no unresolved tool calls

  Scenario: Text that is not in the file is refused and the file is unchanged
    Given the scenario host "garage-mac-1" seeds workspace file "research/notes.txt" containing "alpha beta gamma"
    And a fenced workspace edit handoff with a queued continuation job for "/workspace/research/notes.txt" replacing "omega" with "delta"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records an edit_workspace tool result containing "Could not find the exact text"
    And host "garage-mac-1" has workspace file "research/notes.txt" containing "alpha beta gamma"

  Scenario: Text that occurs more than once is refused and the file is unchanged
    Given the scenario host "garage-mac-1" seeds workspace file "research/notes.txt" containing "one two one"
    And a fenced workspace edit handoff with a queued continuation job for "/workspace/research/notes.txt" replacing "one" with "1"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records an edit_workspace tool result containing "Found 2 occurrences"
    And the turn journal records an edit_workspace tool result containing "provide more context"
    And host "garage-mac-1" has workspace file "research/notes.txt" containing "one two one"

  Scenario: An edit never creates a file
    Given a fenced workspace edit handoff with a queued continuation job for "/workspace/research/missing.txt" replacing "alpha" with "beta"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records an edit_workspace tool result containing "not found"
    And host "garage-mac-1" does not have workspace file "research/missing.txt"

  Scenario: Path escape is rejected on the host
    Given a fenced workspace edit handoff with a queued continuation job for "/workspace/research/notes/../../../../../etc/passwd" replacing "root" with "evil"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records an edit_workspace tool result containing "error:"

  Scenario: A fenced edit handoff re-gates a path outside the granted scope
    Given a human task grants:
      | field          | value               |
      | tools          | edit_workspace      |
      | origins        |                     |
      | recipients     |                     |
      | file_scopes    | /workspace/research |
      | egress_classes |                     |
    And the scenario host "garage-mac-1" seeds workspace file "private/secret.txt" containing "top secret"
    And a fenced workspace edit handoff with a tampered queued continuation job for "/workspace/private/secret.txt" replacing "top" with "public"
    When the computer host has booted through the workspace gate
    And a computer-capable pull worker with a workspace executor pulls that continuation job
    Then the turn journal records a denied edit_workspace tool result
    And host "garage-mac-1" has workspace file "private/secret.txt" containing "top secret"
