Feature: Beta waitlist marketing funnel

  Scenario: The access Chatticus needs is readable before signing up
    Given the beta pitch page
    Then it links to the cross-account CloudFormation template
    And it links to the scoped IAM policy
    And it states that the organization computer runs in the customer AWS account

  Scenario: The survey records which setup path they want
    Given a visitor on the beta page
    When they complete the survey
    Then the waitlist signup records whether they want self-setup or assisted setup

  Scenario: Every cost appears before the first survey question
    Given the beta pitch page
    Then it states the monthly Chatticus fee
    And it states that AWS infrastructure is billed to the customer
    And it states that model tokens are billed to the customer
    And it states the setup fee for each setup path
    And all of them appear above the first survey question

  Scenario: Prices are quoted as round numbers
    Given the beta pitch page
    Then no price on the page ends in .95

  Scenario: The page states what beta means
    Given the beta pitch page
    Then it states that features change without notice
    And it states that there is no uptime guarantee
    And it states that the subscription can be cancelled at any time
    And it states that the deployment stays in the customer account if they leave
