Feature: Beta waitlist marketing funnel

  Scenario: The access Chatticus needs is readable before signing up
    Given the beta pitch page
    Then it links to the cross-account CloudFormation template
    And it links to the scoped IAM policy
    And it states that the organization computer runs in the customer AWS account

  Scenario: The beta page offers setup with and without a fee
    Given the beta pitch page
    Then it offers self-setup with no setup fee
    And it offers assisted setup for a one-time fee
    And both paths state the same monthly price

  Scenario: Self-setup is presented as the normal path
    Given the beta pitch page
    Then it states that most customers run the template themselves

  Scenario: The survey records which setup path they want
    Given a visitor on the beta page
    When they complete the survey
    Then the waitlist signup records whether they want self-setup or assisted setup
