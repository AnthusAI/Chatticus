Feature: Organization identity and membership records
  As a Chatticus operator
  I want durable organization, membership, invitation, and identity records
  So that sign-in and org membership survive store recycling without HTTP or Cognito

  Background:
    Given an empty organization records store

  Scenario: First sign-in mints an identity keyed by verified email
    When "ryan@example.com" signs in for the first time
    Then an identity exists for "ryan@example.com"
    And signing in again as "ryan@example.com" returns the same user id

  Scenario: Creating an organization lands it pending with the owner as a member
    Given "ryan@example.com" has signed in
    When that user creates organization "Anthus Labs"
    Then organization "Anthus Labs" has status "pending"
    And that user is an owner member of "Anthus Labs"

  Scenario: An owner invites a member by email
    Given "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    When the owner of "Anthus Labs" invites "sam@example.com"
    Then a pending invitation exists for "sam@example.com" in "Anthus Labs"

  Scenario: Accepting an invitation to an enabled organization grants immediate access
    Given "ryan@example.com" has signed in
    And that user has created and enabled organization "Anthus Labs"
    And the owner of "Anthus Labs" has invited "sam@example.com"
    When "sam@example.com" signs in
    And that user accepts the invitation to "Anthus Labs"
    Then "sam@example.com" is a member of "Anthus Labs"
    And listing organizations for that user includes "Anthus Labs"

  Scenario: Accepting an invitation to a pending organization is refused
    Given "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    And the owner of "Anthus Labs" has invited "sam@example.com"
    When "sam@example.com" signs in
    And that user tries to accept the invitation to "Anthus Labs"
    Then accepting the invitation is refused because the organization is not enabled

  Scenario: Organization records persist across a recycled store handle
    Given "ryan@example.com" has signed in
    And that user has created and enabled organization "Anthus Labs"
    When the store is recycled
    Then listing organizations for that user still includes "Anthus Labs"
