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

  Scenario: An unconfirmed signup is not queued
    Given a waitlist signup that has not been confirmed
    When an operator lists the waitlist queue
    Then that signup is not in the queue

  Scenario: Confirming the email queues the signup
    Given a waitlist signup that has not been confirmed
    When the visitor follows the confirmation link
    Then that signup is in the queue

  Scenario: A signup carries four price answers
    Given a visitor on the beta page
    When they complete the survey including the price block
    Then the waitlist signup records a too-cheap price
    And it records a bargain price
    And it records an expensive price
    And it records a too-expensive price

  Scenario: The price block asks about total monthly cost
    Given the beta page survey
    Then the price questions name the total including AWS and model tokens

  Scenario: A waitlist signup records the offer terms shown at submission
    Given a visitor on the beta page
    And the current offer terms are known
    When they complete the survey and submit it with the current offer
    Then the waitlist signup records those offer terms

  Scenario: A waitlist signup captures the offer when the client omits it
    Given a visitor on the beta page
    When they complete the survey without sending offer terms
    Then the waitlist signup records the current offer terms

  Scenario: A repeat submission preserves the first offer snapshot
    Given a waitlist signup exists with earlier offer terms
    When a survey is submitted again for that email without offer terms
    Then the signup still records the earlier offer terms

  Scenario: A confirmation link confirms the email
    Given a waitlist signup for jane@example.com with an unconfirmed email
    When a GET request to /waitlist/confirm with the email and a valid token
    Then the response is 200
    And the signup email is marked confirmed
    And the page shows a confirmation message

  Scenario: An invalid token does not confirm
    Given a waitlist signup for jane@example.com with an unconfirmed email
    When a GET request to /waitlist/confirm with the email and an invalid token
    Then the response is 200
    And the signup email is not marked confirmed
    And the page shows an invalid token message

  Scenario: An already-confirmed email shows already confirmed
    Given a waitlist signup for jane@example.com with a confirmed email
    When a GET request to /waitlist/confirm with the email and a valid token
    Then the page shows an already confirmed message
