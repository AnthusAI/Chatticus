Feature: An enabled organization always has an AWS home
  As a Chatticus operator
  I want every organization I enable to be able to start a computer
  So that an organization created in the app is not stuck without a computer after it is enabled

  An organization created in the app starts with no AWS home and no chosen
  setup path. When it is enabled (or reinstated) in that state it becomes
  Anthus-managed: its AWS home is the deployment account and its setup path is
  anthus-managed, the same values the seed records. An organization that
  already chose a setup path, such as a customer account, is left as it is.
  The rule lives in the organization lifecycle, so the members CLI and the
  operator route behave the same.

  Scenario: Enabling a pending organization with no setup path makes it Anthus-managed
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    Then organization "Anthus Labs" is homed in the deployment account as Anthus-managed

  Scenario: Enabling an organization that chose the customer-account setup path leaves it alone
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Customer Co"
    And organization "Customer Co" already chose the customer-account setup path
    When the members CLI enables organization "Customer Co" with confirmation
    Then organization "Customer Co" keeps the setup path "customer-owned" and has no AWS account

  Scenario: Enabling, suspending and reinstating keep one home
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    And the members CLI suspends organization "Anthus Labs" with confirmation
    And the members CLI reinstates organization "Anthus Labs" with confirmation
    Then organization "Anthus Labs" is homed in the deployment account as Anthus-managed

  Scenario: Reinstating a suspended organization that never had a home gives it one
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    And organization "Anthus Labs" is suspended with no AWS home and no setup path
    When the members CLI reinstates organization "Anthus Labs" with confirmation
    Then organization "Anthus Labs" is homed in the deployment account as Anthus-managed

  Scenario: Enabling an organization that is already enabled is refused and changes nothing
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    And the members CLI enables organization "Anthus Labs" without checking the outcome
    Then the members CLI refused the command
    And organization "Anthus Labs" is homed in the deployment account as Anthus-managed

  Scenario: The operator enable route homes an unchosen organization in the deployment account
    Given an empty organization records store
    And the customer self-setup HTTP front door is wired with an in-memory role inspector
    And a pending organization owned by "owner@example.com"
    And an authenticated operator credential
    When the operator calls the enable endpoint for that pending organization
    Then the operator response status is 200
    And that pending organization is enabled in the deployment account as Anthus-managed
