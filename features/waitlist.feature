Feature: Public waitlist submission

  Scenario: The waitlist route is outside the principal system
    Given the thin-turn front door
    Then "/waitlist" is a named no-principal route

  Scenario: A caller without a principal may post a waitlist signup
    Given a visitor with no Chatticus account
    When they post a complete waitlist survey
    Then the response is 201
    And no principal was resolved for the request
