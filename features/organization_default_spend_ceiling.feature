Feature: Every organization starts with a fifty dollar monthly spend ceiling
  As the owner of a Chatticus organization
  I want a monthly AWS spend ceiling in place from the first day
  So that a runaway computer cannot spend more than fifty dollars before anyone looks

  A new organization starts with a monthly ceiling of 50.00 US dollars, whether
  it was created in the app or seeded by the operator. An owner who sets up
  their own AWS account replaces it with the ceiling they choose, and an owner
  can raise it at any time. Organizations created before this rule hold no
  ceiling at all, so nothing pauses their computer work however much it costs.
  migrate-organization-spend-ceiling gives each of them the 50.00 ceiling,
  once. It is a dry run unless --execute is given. It writes only the
  ceiling, and only while the organization still holds none, so it never
  changes a ceiling an owner set, even one set while it runs. Giving an
  organization a ceiling can pause its computer work at once if its month
  already cost more, so run the dry run first.

  Scenario: An organization created in the app starts with the fifty dollar ceiling
    Given an empty organization records store
    And "ryan@example.com" has signed in
    When that user creates organization "Anthus Labs"
    Then organization "Anthus Labs" has a monthly spend ceiling of 50.00

  Scenario: An organization seeded by the operator starts with the fifty dollar ceiling
    Given an empty organization records store
    When the operator seeds organization "Seeded Co" for "ryan@example.com"
    Then organization "Seeded Co" has a monthly spend ceiling of 50.00

  Scenario: A dry run reports the organization it would give the ceiling and writes nothing
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    And organization "Anthus Labs" is enabled with no monthly spend ceiling
    When the organization spend ceiling migration runs as a dry run
    Then the spend ceiling migration reports "would_set_ceiling" for organization "Anthus Labs"
    And organization "Anthus Labs" has no monthly spend ceiling

  Scenario: Running the migration gives the organization the fifty dollar ceiling
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    And organization "Anthus Labs" is enabled with no monthly spend ceiling
    When the organization spend ceiling migration runs for real
    Then the spend ceiling migration reports "set_ceiling" for organization "Anthus Labs"
    And organization "Anthus Labs" has a monthly spend ceiling of 50.00
    And organization "Anthus Labs" is still enabled

  Scenario: Running the migration twice changes nothing the second time
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    And organization "Anthus Labs" is enabled with no monthly spend ceiling
    When the organization spend ceiling migration runs for real
    And the organization spend ceiling migration runs for real
    Then the spend ceiling migration reports nothing to change

  Scenario: A pending or suspended organization without a ceiling is given one too
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Waiting Co"
    And organization "Waiting Co" was created before the default ceiling and holds none
    And that user has created organization "Paused Co"
    And organization "Paused Co" is suspended with no monthly spend ceiling
    When the organization spend ceiling migration runs for real
    Then the spend ceiling migration reports "set_ceiling" for organization "Waiting Co"
    And the spend ceiling migration reports "set_ceiling" for organization "Paused Co"

  Scenario: A ceiling the owner already set is never changed
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Big Spender"
    And organization "Big Spender" is enabled with a monthly spend ceiling of 500.00
    When the organization spend ceiling migration runs for real
    Then the spend ceiling migration does not mention organization "Big Spender"
    And organization "Big Spender" has a monthly spend ceiling of 500.00

  Scenario: A ceiling the owner sets while the migration runs is kept
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    And organization "Anthus Labs" is enabled with no monthly spend ceiling
    And the owner of "Anthus Labs" sets a monthly spend ceiling of 500.00 after the migration reads it
    When the organization spend ceiling migration runs for real
    Then the spend ceiling migration does not mention organization "Anthus Labs"
    And organization "Anthus Labs" has a monthly spend ceiling of 500.00

  Scenario: The migration can be limited to one organization
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    And organization "Anthus Labs" is enabled with no monthly spend ceiling
    And that user has created organization "Second Co"
    And organization "Second Co" is enabled with no monthly spend ceiling
    When the organization spend ceiling migration runs for real for organization "Second Co"
    Then the spend ceiling migration reports "set_ceiling" for organization "Second Co"
    And the spend ceiling migration does not mention organization "Anthus Labs"
    And organization "Anthus Labs" has no monthly spend ceiling
