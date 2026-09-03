Feature: Waitlist operator CLI
  As a Chatticus operator
  I want a CLI that lists and exports scored waitlist signups
  So that I can prioritize outreach without a dashboard

  Scenario: List the queue highest score first
    Given confirmed waitlist signups with a range of scores
    When the waitlist CLI lists the queue
    Then the waitlist CLI output is ordered by score descending
    And no disqualified signup appears in the waitlist CLI output

  Scenario: List only the services-qualified
    Given confirmed waitlist signups with a range of scores
    When the waitlist CLI lists the queue filtered to services-qualified
    Then every signup in the waitlist CLI output scored at least 10

  Scenario: Export the queue for analysis
    Given confirmed waitlist signups
    When the waitlist CLI exports the waitlist as CSV
    Then each CSV row carries the survey answers, the score, and the price block

  Scenario: List disqualified signups separately
    Given confirmed waitlist signups on AWS and on other clouds
    When the waitlist CLI lists disqualified signups
    Then every signup in the waitlist CLI output is disqualified
    And no queued signup appears in the waitlist CLI output
