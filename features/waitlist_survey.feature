Feature: Waitlist survey submission

  Scenario: A complete survey creates one waitlist signup
    Given a visitor on the beta page
    When they complete the survey and submit it
    Then a waitlist signup is recorded for their work email
    And it carries their fit, AWS readiness, and price answers

  Scenario: An abandoned survey still leaves a lead
    Given a visitor who has entered only their work email
    When they leave the page without submitting
    Then a waitlist signup is recorded for that email
    And it is marked incomplete

  Scenario: A second submission from one email updates the first
    Given a waitlist signup exists for "sam@example.com"
    When a survey is submitted again for "SAM@example.com"
    Then one waitlist signup exists for "sam@example.com"
    And it carries the answers from the second submission

  Scenario: Completing an abandoned survey fills in the same signup
    Given an incomplete waitlist signup exists for "sam@example.com"
    When that visitor returns and completes the survey
    Then one waitlist signup exists for "sam@example.com"
    And it is no longer marked incomplete
