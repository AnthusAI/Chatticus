Feature: Organizations enabled before the AWS home rule are given their home once
  As the operator of a hosted environment
  I want organizations that were enabled without an AWS home to be homed in the deployment account
  So that they can start a computer without being seeded one by one

  An organization created in the app is homed in the deployment account when it
  is enabled, unless its owner chose a setup path first. Organizations enabled
  before that rule hold no home and no setup path, so every computer start for
  them is refused. migrate-organization-aws-home gives each of them the
  deployment account and the anthus-managed setup path, once. It is a dry run
  unless --execute is given. Pending organizations are left alone because
  enabling them applies the rule; suspended ones get it when reinstated;
  organizations that chose a setup path are never touched.

  Background:
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    And organization "Anthus Labs" is enabled with no AWS home and no setup path

  Scenario: A dry run reports the organization it would home and writes nothing
    When the organization AWS home migration runs as a dry run
    Then the migration reports "would_home" for organization "Anthus Labs"
    And organization "Anthus Labs" has no AWS home and no setup path

  Scenario: Running the migration homes the organization in the deployment account
    When the organization AWS home migration runs for real
    Then the migration reports "homed" for organization "Anthus Labs"
    And organization "Anthus Labs" is homed in the deployment account as Anthus-managed
    And organization "Anthus Labs" is still enabled

  Scenario: Running the migration twice changes nothing the second time
    When the organization AWS home migration runs for real
    And the organization AWS home migration runs for real
    Then the migration reports nothing to home
    And organization "Anthus Labs" is homed in the deployment account as Anthus-managed

  Scenario: An organization that chose the customer-account setup path is never touched
    Given that user has created organization "Customer Co"
    And organization "Customer Co" is enabled with no AWS home but the customer-account setup path
    When the organization AWS home migration runs for real
    Then the migration reports "homed" for organization "Anthus Labs"
    And the migration does not mention organization "Customer Co"
    And organization "Customer Co" keeps the setup path "customer-owned" and has no AWS account

  Scenario: A pending organization is left for the enable rule
    Given that user has created organization "Waiting Co"
    When the organization AWS home migration runs for real
    Then the migration does not mention organization "Waiting Co"
    And organization "Waiting Co" has no AWS home and no setup path

  Scenario: The migration can be limited to one organization
    Given that user has created organization "Second Co"
    And organization "Second Co" is enabled with no AWS home and no setup path
    When the organization AWS home migration runs for real for organization "Second Co"
    Then the migration reports "homed" for organization "Second Co"
    And the migration does not mention organization "Anthus Labs"
    And organization "Anthus Labs" has no AWS home and no setup path
