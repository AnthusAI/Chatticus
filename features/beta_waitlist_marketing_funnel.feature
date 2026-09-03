Feature: Beta waitlist marketing funnel

  Scenario: The access Chatticus needs is readable before signing up
    Given the beta pitch page
    Then it links to the cross-account CloudFormation template
    And it links to the scoped IAM policy
    And it states that the organization computer runs in the customer AWS account
