Feature: First organization seed before enforcement
  As a Chatticus operator
  I want to seed and bootstrap organization records from the members CLI
  So that enforcement does not lock every environment before anyone has enabled membership

  Scenario: Cold path creates a pending organization then enables without a computer
    Given an empty organization records store
    When the members CLI creates organization "Bootstrap Labs" for owner "owner@example.com"
    Then organization "Bootstrap Labs" has status "pending"
    When the members CLI lists organizations with status "pending"
    Then the members CLI output includes organization "Bootstrap Labs"
    When the members CLI enables organization "Bootstrap Labs" with confirmation
    Then organization "Bootstrap Labs" has status "enabled"
    And no computer exists for "Bootstrap Labs"

  Scenario: Anthus backfill preserves existing messaging rows
    Given a messaging store with tenant "anthus" user "ryan" bot data and no organization records
    When the members CLI seeds tenant "anthus" for owner "owner@example.com" with confirmation
    Then organization tenant "anthus" has status "enabled"
    And an identity exists for "owner@example.com"
    And "owner@example.com" is an owner member of tenant "anthus"
    And tenant "anthus" user "ryan" bot data still exists
    And no computer exists for tenant "anthus"
    When the members CLI seeds tenant "anthus" for owner "owner@example.com" with confirmation again
    Then organization tenant "anthus" has status "enabled"

  Scenario: A different email is not an owner of seeded anthus
    Given a messaging store with tenant "anthus" user "ryan" bot data and no organization records
    When the members CLI seeds tenant "anthus" for owner "owner@example.com" with confirmation
    When "other@example.com" signs in
    Then "other@example.com" is not a member of tenant "anthus"

  Scenario: Cold path seeds anthus enabled with Anthus AI Solutions on empty store
    Given an empty organization records store
    When the members CLI seeds tenant "anthus" for owner "ryan@anth.us" named "Anthus AI Solutions" with confirmation
    Then organization tenant "anthus" has status "enabled"
    And organization tenant "anthus" has display name "Anthus AI Solutions"
    And an identity exists for "ryan@anth.us"
    And the identity for "ryan@anth.us" is keyed in lowercase
    And "ryan@anth.us" is an owner member of tenant "anthus"
    And no computer exists for tenant "anthus"
    When the members CLI lists organizations with status "enabled"
    Then the members CLI output includes tenant "anthus"
