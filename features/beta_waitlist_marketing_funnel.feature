Feature: Beta waitlist marketing funnel

  Background:
    Given a visitor on the beta pitch page

  Scenario: the survey form fetches question blocks from the API
    When the page loads
    Then it fetches GET /waitlist/survey
    And it renders an email field, a fit block, an AWS readiness block, a setup-path block, a price sensitivity block, a professional services interest question, and a training interest question

  Scenario: a complete survey submission is recorded
    Given a visitor who has filled in their work email and all survey blocks
    When they submit the survey
    Then it posts to POST /waitlist with complete: true
    And the page shows a thank-you confirmation

  Scenario: an abandoned survey still leaves a lead from the form
    Given a visitor who has entered only their work email
    When they blur their email without submitting
    Then it posts to POST /waitlist with complete: false on email blur
    And a waitlist signup is recorded for that email marked incomplete

  Scenario: a rate-limited submission shows an error
    Given a source that has submitted at the allowed limit
    When they submit again from the survey form
    Then the page shows a rate-limit message

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

  Scenario: UTM parameters are captured from the URL
    Given a visitor arrives at /beta with utm_source=google and utm_campaign=beta_launch
    When they submit the survey
    Then the waitlist signup records the UTM source, medium, campaign, content, and term

  Scenario: a page view event is fired on load
    When the visitor loads the beta page
    Then a page_view event is fired

  Scenario: a signup_complete conversion event is fired on survey submission
    Given a visitor who completes the survey
    When they submit it
    Then a signup_complete conversion event is fired
