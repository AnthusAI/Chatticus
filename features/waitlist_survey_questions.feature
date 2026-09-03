Feature: Survey question definitions

  Background:
    Given the waitlist survey API

  Scenario: the survey defines a fit block
    Then GET /waitlist/survey returns a fit block with questions about organization size, seniority, urgency, and work description

  Scenario: the survey defines an AWS readiness block
    Then GET /waitlist/survey returns an AWS readiness block with questions about cloud provider, account status, and IAM comfort

  Scenario: the survey defines a setup-path block
    Then GET /waitlist/survey returns a setup-path block asking whether they want self-install or turn-key

  Scenario: the survey defines a professional services interest question
    Then GET /waitlist/survey returns a question asking if they are interested in professional services for integrating with custom resources

  Scenario: the survey defines a professional training interest question
    Then GET /waitlist/survey returns a question asking if they are interested in professional training for their staff

  Scenario: scored questions return choices with value and label
    Then GET /waitlist/survey returns organization size choices with value and label
    And GET /waitlist/survey returns professional services interest choices with value and label

  Scenario: GET /waitlist/survey returns choices for scored questions
    Then GET /waitlist/survey returns choices on scored fit questions
    And GET /waitlist/survey returns choices on scored AWS readiness questions
