Feature: Only the Front Door writes the edit overlay

  As an operator
  I want the overlay of edits made while the computer is off to be written only by the Front Door, and only with conditional writes
  So that a compromised owner cannot add, change or remove an edit, and two members cannot overwrite each other

  The overlay is one small object per edited file and an index, under the computer's prefix in the snapshot bucket. The
  Front Door is the only writer. The supervisor's role may read the index and the blobs and nothing else of the overlay, and
  the per-turn role of a bot's computer owner cannot reach the overlay at all. The Front Door writes a blob only if it does not
  exist and the index only if it is still the one it read. The contract is docs/LIVE_FILES_PROTOCOL.md section 12.8.

  Background:
    Given an empty control plane
    And the household computer of tenant "anthus" with members "ryan" and "mia"
    And an edit overlay kept in the snapshot bucket itself

  @server
  Scenario: The owner roles cannot write or delete overlay objects
    Then the per-turn role policy denies s3:GetObject, s3:PutObject and s3:DeleteObject on "tenants/anthus/computers/household-computer/overlay/index.json"
    And the per-turn role policy denies s3:PutObject and s3:DeleteObject on "tenants/anthus/computers/household-computer/overlay/blobs/abc"
    And the supervisor role policy allows s3:GetObject on "tenants/anthus/computers/household-computer/overlay/index.json"
    And the supervisor role policy denies s3:PutObject, s3:DeleteObject and s3:DeleteObjectVersion on "tenants/anthus/computers/household-computer/overlay/index.json"
    And the supervisor role policy denies s3:PutObject on "tenants/anthus/computers/household-computer/overlay/blobs/abc"
    And the supervisor role policy still allows s3:PutObject on "tenants/anthus/computers/household-computer/snapshot.tar.gz"
    And the supervisor role policy denies every action on the overlay of another computer

  @server
  Scenario: The Front Door writes the overlay with conditional puts
    Given the computer disk is published
    And no owner is running
    When member "mia" creates the computer file "/workspace/fresh.md" with "new"
    And member "mia" creates the computer file "/workspace/second.md" with "more"
    Then the overlay blob was put with "If-None-Match: *"
    And the overlay index was put with a condition on the entity tag it had read
