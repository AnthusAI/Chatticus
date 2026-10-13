Feature: Edits made while the computer is off are kept in an overlay that the owner seals, applies and clears
  As a member of an organization
  I want my edit to a file to be kept when the computer is off and to reach the computer when it starts
  So that I never need the computer running to change a file, and no edit is lost or applied over someone else's

  The computer is needed only to run things. While it is off, an edit is kept in an overlay in the snapshot bucket: one
  index object, replaced only by compare-and-swap, and one immutable blob per edited file. Only the Front Door writes it.
  The next owner of the computer seals the overlay after it extracts the snapshot: from then on the overlay belongs to
  that owner and member writes wait. The seal is the single point at which an edit and the owner are ordered, so an edit
  is either in the set the owner seals or is told to try again, never both and never neither. The owner applies the set,
  and asks to clear an entry only after a publish that holds it is on record. A seal left by an owner that died is stale
  and is replaced by the next write. A change on both sides is a conflict that is kept and shown, never applied
  silently. The contract is docs/LIVE_FILES_PROTOCOL.md (sections 7.7 and 7.8); the wire schemas are in
  host-protocol/src/edit-overlay.ts. This feature is the Front Door side of the overlay. The owner side (applying the
  set on the disk) is told in the supervisor features, and reading and writing through the file routes in
  computer_file_live.feature.

  Background:
    Given an empty control plane
    And a fake owner credential broker
    And the organization is homed in the deployment account
    And the household computer of tenant "anthus" with members "ryan" and "mia"
    And an edit overlay over a snapshot bucket

  # ---------------------------------------------------------------- discarding

  @server
  Scenario: A member discards their own pending edit
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And member "mia" saved "/workspace/notes.md" as "second draft" in the overlay
    When member "mia" discards the pending edit of "/workspace/notes.md" through the discard route
    Then the overlay answer status is 200
    And the edit overlay holds no entry for "/workspace/notes.md"
    And the effective hash of "/workspace/notes.md" is the hash of "first draft"
    And the overlay audit trail has a record for member "mia" with operation "discard"
    And the blob of "second draft" is deleted

  @server
  Scenario: A discard that names a revision that is no longer the entry's is refused
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And member "mia" saved "/workspace/notes.md" as "second draft" in the overlay
    When member "ryan" discards revision 7 of the pending edit of "/workspace/notes.md" through the discard route
    Then the overlay answer status is 409
    And the overlay answer error is "precondition_failed"
    And the edit overlay holds "second draft" for "/workspace/notes.md"

  # ---------------------------------------------------------------- the seal

  @server
  Scenario: An edit made while the owner extracts the snapshot is in the set the owner seals
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And an owner of the household computer is hydrating
    When member "mia" edits "/workspace/notes.md" to "second draft" if it still has the hash of "first draft"
    Then the overlay edit is recorded
    When the owner seals the overlay
    Then the sealed entries are exactly:
      | path                | sha256                     |
      | /workspace/notes.md | the hash of "second draft" |

  @server
  Scenario: An edit made after the owner sealed the overlay waits for the owner
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And an owner of the household computer is hydrating
    And the owner sealed the overlay
    When member "mia" edits "/workspace/notes.md" to "second draft" if it still has the hash of "first draft"
    Then the overlay edit is refused with status 503 and code "computer_starting"
    And the refusal says "retry_after_ms" is 2000
    And the edit overlay holds no entry for "/workspace/notes.md"
    And the overlay audit trail has no records

  @server
  Scenario: An edit made after the owner started to stop is told to wait longer
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And an owner of the household computer is hydrating
    And the owner sealed the overlay
    And the owner polls in state "stopping"
    When member "mia" edits "/workspace/notes.md" to "second draft" if it still has the hash of "first draft"
    Then the overlay edit is refused with status 503 and code "computer_stopping"
    And the refusal says "retry_after_ms" is 5000

  @server
  Scenario: A seal and an edit that race leave exactly one of them in charge
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And an owner of the household computer is hydrating
    When the owner seals the overlay at the same instant as member "mia" edits "/workspace/notes.md"
    Then either the sealed entries hold the edit or the edit was answered "computer_starting"
    And never both and never neither

  @server
  Scenario: The stopped report ends the seal and loses no entry
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And member "mia" saved "/workspace/notes.md" as "second draft" in the overlay
    And an owner of the household computer is hydrating
    And the owner sealed the overlay
    When the owner reports the computer stopped for generation 1
    Then the edit overlay is not sealed
    And the edit overlay holds "second draft" for "/workspace/notes.md"

  # ---------------------------------------------------------------- stale seals and generations

  @server
  Scenario: A seal left by an owner that died is replaced by the next edit
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And the overlay was sealed by an owner whose heartbeat then lapsed
    When member "mia" edits "/workspace/notes.md" to "second draft" if it still has the hash of "first draft"
    Then the overlay edit is recorded
    And the edit overlay is not sealed
    And the edit overlay holds "second draft" for "/workspace/notes.md"

  @server
  Scenario: An owner of an older generation cannot seal or clear
    Given the overlay was sealed by an owner of generation 1
    And a newer owner of generation 2 has bootstrapped
    When the owner of generation 1 asks to seal the overlay
    Then the owner request is refused with code "stale_generation"
    When the owner of generation 1 asks to clear "/workspace/notes.md"
    Then the owner request is refused with code "stale_generation"

  @server
  Scenario: A clear that is not sealed by the caller is refused
    Given the computer disk is published
    And an owner of the household computer is hydrating
    When the owner asks to clear "/workspace/notes.md" before it sealed the overlay
    Then the owner request is refused with code "overlay_not_sealed"

  @server
  Scenario: A clear by an owner whose seal was replaced is refused
    Given the overlay was sealed by an owner of generation 1
    And the seal of the overlay was replaced by a member write after the owner's heartbeat lapsed
    When the owner of generation 1 asks to clear "/workspace/notes.md"
    Then the owner request is refused with code "overlay_not_sealed"

  # ---------------------------------------------------------------- clearing

  @server
  Scenario: Clearing removes only the entries that were applied
    Given the computer disk is published
    And member "mia" saved "/workspace/a.md" as "a2" and "/workspace/b.md" as "b2" in the overlay
    And an owner of the household computer is hydrating
    And the owner sealed the overlay
    And the owner publishes a snapshot and the control plane records it
    When the owner asks to clear "/workspace/a.md" at the revision it applied
    Then the owner request is answered with 1 entry remaining
    And the edit overlay holds no entry for "/workspace/a.md"
    And the edit overlay holds "b2" for "/workspace/b.md"
    And the blob of "a2" is deleted and the blob of "b2" is kept
    And the overlay audit trail has a record with operation "overlay_apply" and outcome "ok" for "/workspace/a.md"

  @server
  Scenario: A clear that names an entry that changed since is ignored
    Given the computer disk is published
    And member "mia" saved "/workspace/a.md" as "a2" in the overlay
    And an owner of the household computer is hydrating
    And the owner sealed the overlay
    And the owner publishes a snapshot and the control plane records it
    When the owner asks to clear "/workspace/a.md" at revision 99
    Then the owner request is answered with 1 entry remaining
    And the edit overlay still holds "a2" for "/workspace/a.md"

  @server
  Scenario: A clear before any publish is recorded is refused
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And member "mia" saved "/workspace/notes.md" as "second draft" in the overlay
    And an owner of the household computer is hydrating
    And the owner sealed the overlay
    When the owner asks to clear "/workspace/notes.md" at the revision it applied
    Then the owner request is answered with 1 entry remaining
    And the edit overlay still holds "second draft" for "/workspace/notes.md"
    When the owner publishes a snapshot and the control plane records it
    And the owner asks to clear "/workspace/notes.md" at the revision it applied
    Then the owner request is answered with 0 entries remaining
    And the edit overlay holds no entry for "/workspace/notes.md"

  @server
  Scenario: An entry that the saved copy already shows is cleared without waiting for a publish record
    Given the computer disk holds workspace file "notes.md" containing "first draft"
    And the computer disk is published
    And member "mia" saved "/workspace/notes.md" as "second draft" in the overlay
    And an owner of the household computer is hydrating
    And the owner sealed the overlay
    And the computer disk holds workspace file "notes.md" containing "second draft"
    And the computer disk is published
    When the owner asks to clear "/workspace/notes.md" at the revision it applied
    Then the owner request is answered with 0 entries remaining
    And the edit overlay holds no entry for "/workspace/notes.md"

  # ---------------------------------------------------------------- conflicts

  @server
  Scenario: A snapshot that moved under an edit shows a conflict and keeps both versions
    Given the computer disk holds workspace file "plan.md" containing "v1"
    And the computer disk is published
    And member "mia" saved "/workspace/plan.md" as "from Mia" in the overlay
    And the computer disk holds workspace file "plan.md" containing "from the host"
    And the computer disk is published
    Then the effective view shows "/workspace/plan.md" with the hash of "from the host" marked "conflict" and the person's hash of "from Mia"
    And the person's version of "/workspace/plan.md" in the overlay reads "from Mia"

  @server
  Scenario: An edit made on both sides conflicts and is never applied silently
    Given the computer disk holds workspace file "plan.md" containing "v1"
    And the computer disk is published
    And member "mia" saved "/workspace/plan.md" as "from Mia" in the overlay
    And the computer disk holds workspace file "plan.md" containing "from the host"
    And the computer disk is published
    When member "ryan" edits "/workspace/plan.md" to "from Ryan" if it still has the hash of "v1"
    Then the overlay edit is refused with status 409 and code "precondition_failed"
    And the refusal says "current_sha256" is the hash of "from the host"
    When member "mia" edits "/workspace/plan.md" to "from Mia again" if it still has the hash of "from the host"
    Then the overlay edit is recorded
    And the edit overlay holds "from Mia again" for "/workspace/plan.md" with base hash of "from the host"

  @server
  Scenario: A conflict can be dropped explicitly
    Given the computer disk holds workspace file "plan.md" containing "v1"
    And the computer disk is published
    And member "mia" saved "/workspace/plan.md" as "from Mia" in the overlay
    And the computer disk holds workspace file "plan.md" containing "from the host"
    And the computer disk is published
    When member "mia" discards the pending edit of "/workspace/plan.md" through the discard route
    Then the edit overlay holds no entry for "/workspace/plan.md"
    And the effective hash of "/workspace/plan.md" is the hash of "from the host"

  @server
  Scenario: A conflict the owner reports is stored on the entry and audited
    Given the computer disk holds workspace file "plan.md" containing "v1"
    And the computer disk is published
    And member "mia" saved "/workspace/plan.md" as "from Mia" in the overlay
    And an owner of the household computer is hydrating
    And the owner sealed the overlay
    When the owner reports a conflict for "/workspace/plan.md" with the disk hash of "from the host"
    Then the owner request is answered with 1 entry remaining
    And the effective view shows "/workspace/plan.md" with the hash of "v1" marked "conflict" and the person's hash of "from Mia"
    And the overlay audit trail has a record with operation "overlay_apply" and outcome "conflict" for "/workspace/plan.md"
