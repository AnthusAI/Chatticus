Feature: Members administrator CLI
  As a Chatticus operator
  I want a CLI that lists and enables waitlist organizations
  So that I can onboard tenants without provisioning computers

  Scenario: List pending organizations then enable without a computer
    Given an empty organization records store
    And "ryan@example.com" has signed in
    And that user has created organization "Anthus Labs"
    When the members CLI lists organizations with status "pending"
    Then the members CLI output includes organization "Anthus Labs"
    When the members CLI enables organization "Anthus Labs" with confirmation
    Then organization "Anthus Labs" has status "enabled"
    And no computer exists for "Anthus Labs"
