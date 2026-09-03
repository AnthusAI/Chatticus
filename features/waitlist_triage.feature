Feature: Waitlist triage

  Scenario: A senior AWS buyer with budget scores highly
    Given a complete waitlist signup for "buyer@example.com" with email not yet confirmed
    And they run production workloads on AWS
    And their organization has 101 or more people
    And they answered yes with budget to professional services
    And they can approve AWS access themselves
    When the visitor confirms their email
    Then the signup waitlist score is at least 10
    And the signup is marked services-qualified

  Scenario: A curious individual scores low
    Given a complete waitlist signup for "curious@example.com" with email not yet confirmed
    And their organization has 1 to 5 people
    And they answered not now to professional services
    And they are just exploring
    When the visitor confirms their email
    Then the signup is not marked services-qualified

  Scenario: A score records the weights it was computed with
    Given a complete waitlist signup for "version@example.com" with email not yet confirmed
    When the visitor confirms their email
    Then the signup carries scoring weights version "waitlist-weights-v1"

  Scenario: Confirming via HTTP stores the waitlist score
    Given a complete waitlist signup for "jane@example.com" with email not yet confirmed
    And they run production workloads on AWS
    And their organization has 101 or more people
    And they answered yes with budget to professional services
    And they can approve AWS access themselves
    When a GET request to /waitlist/confirm with the email and a valid token
    Then the signup email is marked confirmed
    And the signup waitlist score is at least 10
    And the signup is marked services-qualified
    And the signup carries scoring weights version "waitlist-weights-v1"

  Scenario: A repeat survey submission preserves the waitlist score
    Given a complete waitlist signup for "sam@example.com" with email not yet confirmed
    And they run production workloads on AWS
    And their organization has 101 or more people
    And they answered yes with budget to professional services
    And they can approve AWS access themselves
    When the visitor confirms their email
    And a survey is submitted again for "sam@example.com"
    Then the signup still carries the original waitlist score
    And the signup still carries scoring weights version "waitlist-weights-v1"
    And the signup is still marked services-qualified
