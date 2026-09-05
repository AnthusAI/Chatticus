Feature: Public waitlist submission

  Scenario: The waitlist route is outside the principal system
    Given the thin-turn front door
    Then "/waitlist" is a named no-principal route

  Scenario: A caller without a principal may post a waitlist signup
    Given a visitor with no Chatticus account
    When they post a complete waitlist survey
    Then the response is 201
    And no principal was resolved for the request

  Scenario: Repeated submissions from one source are refused
    Given a source that has submitted the waitlist survey at the allowed limit
    When that source submits the survey again
    Then the response is 429
    And no additional waitlist signup is recorded

  Scenario: UTM parameters are persisted on the signup
    When they post a waitlist survey with UTM source google and campaign beta_launch
    Then the waitlist signup records the UTM source and campaign
