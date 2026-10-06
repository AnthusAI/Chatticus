Feature: Host protocol between the Front Door and a computer host
  As the operator of an organization computer
  I want the host to reach the control plane through nine routes under /host and nothing else
  So that the host runs tool actions without holding transcript or table credentials

  The host claims an action under a lease, runs it on the live disk, and posts
  the result. The executor decided the policy before it created the action, so
  the host enforces the envelope and asks to regate only for a target the
  envelope did not foresee.

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP

  Scenario: A host reads the organization computer
    Given host worker "host-one" serves the household computer
    And tenant "anthus" user "ryan" household computer is stopped
    When host worker "host-one" reads the computer
    Then the host request is accepted
    And host worker "host-one" sees the computer stopped
    And host worker "host-one" sees the "browser" capability not ready

  Scenario: A host reports the computer running and a capability ready
    Given host worker "host-one" serves the household computer
    And tenant "anthus" user "ryan" household computer is stopped
    When host worker "host-one" reports the computer running
    And host worker "host-one" reports the "browser" capability ready
    Then the host request is accepted
    And host worker "host-one" sees the computer running
    And host worker "host-one" sees the "browser" capability ready

  Scenario: A host reporting a capability the computer does not have is refused
    Given host worker "host-one" serves the household computer
    When host worker "host-one" reports the "teleport" capability ready
    Then the host request is refused with status 422

  Scenario: A host reporting nothing is refused
    Given host worker "host-one" serves the household computer
    When host worker "host-one" reports a computer state with nothing in it
    Then the host request is refused with status 422

  Scenario: A caller without a worker credential is refused
    Given host worker "host-one" serves the household computer
    When a caller with no worker credential claims an action
    Then the host request is refused with status 403

  Scenario: A host publishes its snapshot
    Given host worker "host-one" serves the household computer
    When host worker "host-one" publishes a snapshot with checksum "c0ffee"
    Then the host request is accepted
    And host worker "host-one" sees snapshot generation 1 with checksum "c0ffee"

  Scenario: A host hydrates a snapshot that was published
    Given host worker "host-one" serves the household computer
    And host worker "host-one" publishes a snapshot with checksum "c0ffee"
    When host worker "host-one" reports its snapshot hydrated
    Then the host request is accepted

  Scenario: A host cannot report hydration before any snapshot was published
    Given host worker "host-one" serves the household computer
    When host worker "host-one" reports its snapshot hydrated
    Then the host request is refused with status 400 saying "has no published snapshot"

  Scenario: A host cannot report a snapshot as another worker
    Given host worker "host-one" serves the household computer
    And host worker "host-two" serves the household computer
    When host worker "host-one" reports the snapshot hydrated as worker "host-two"
    Then the host request is refused with status 403 saying "does not match worker_id"

  Scenario: A host with nothing waiting is given no action
    Given host worker "host-one" serves the household computer
    When host worker "host-one" claims the next action
    Then the host is given no action

  Scenario: A host claims the action a turn parked on, under a lease
    Given a fenced computer handoff with a queued continuation job
    And host worker "host-one" serves the household computer
    And host worker "host-two" serves the household computer
    When host worker "host-one" claims the next action
    Then the host is given a "read_workspace" action for the parked turn under a lease
    When host worker "host-two" claims the next action
    Then the host is given no action

  Scenario: A host renews the lease of the action it holds
    Given a fenced computer handoff with a queued continuation job
    And host worker "host-one" serves the household computer
    And the host worker "host-one" holds the pending action
    When 30 seconds pass
    And host worker "host-one" renews the action it holds
    Then the host request is accepted
    And the lease of that action ends later than before

  Scenario: A host that does not hold the action cannot renew it
    Given a fenced computer handoff with a queued continuation job
    And host worker "host-one" serves the household computer
    And host worker "host-two" serves the household computer
    And the host worker "host-one" holds the pending action
    When host worker "host-two" renews the action it holds
    Then the host request is refused with status 409

  Scenario: The result of an action resumes the parked turn
    Given a fenced computer handoff with a queued continuation job
    And host worker "host-one" serves the household computer
    And the host worker "host-one" holds the pending action
    When host worker "host-one" posts the result "opened" for the action it holds
    Then the host request is accepted
    And the host is told the parked turn was resumed
    And exactly one run job is queued for the turn
    When the platform runs the queued turn jobs
    Then the turn journal records a tool result containing "opened" for the pending action id

  Scenario: An error from the tool resumes the parked turn with the error as its result
    Given a fenced computer handoff with a queued continuation job
    And host worker "host-one" serves the household computer
    And the host worker "host-one" holds the pending action
    When host worker "host-one" posts the error "disk full" for the action it holds
    Then the host request is accepted
    When the platform runs the queued turn jobs
    Then the turn journal records a tool result containing "disk full" for the pending action id

  Scenario: A result that is also an error is refused
    Given a fenced computer handoff with a queued continuation job
    And host worker "host-one" serves the household computer
    And the host worker "host-one" holds the pending action
    When host worker "host-one" posts both a result and an error for the action it holds
    Then the host request is refused with status 422

  Scenario: A host may regate a path the turn grant covers
    Given a fenced computer handoff with a queued continuation job
    And host worker "host-one" serves the household computer
    And the host worker "host-one" holds the pending action
    When host worker "host-one" asks to regate read of "/workspace/inbox.txt"
    Then the host request is accepted

  Scenario: A host is refused a path outside the turn grant
    Given a fenced computer handoff with a queued continuation job
    And host worker "host-one" serves the household computer
    And the host worker "host-one" holds the pending action
    When host worker "host-one" asks to regate read of "/etc/passwd"
    Then the host request is refused with status 403

  Scenario: A host is refused an origin the turn grant does not name
    Given a fenced computer handoff with a queued continuation job
    And host worker "host-one" serves the household computer
    And the host worker "host-one" holds the pending action
    When host worker "host-one" asks to regate browse of "https://evil.example.com/steal"
    Then the host request is refused with status 403

  Scenario: A host sends a heartbeat
    Given host worker "host-one" serves the household computer
    When host worker "host-one" sends a heartbeat
    Then the host request is accepted
