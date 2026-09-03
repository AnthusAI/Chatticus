Feature: Contact forms for professional services and training

  Background:
    Given the Chatticus marketing site

  Scenario: a professional services contact form exists at /contact/services
    Given a visitor on the contact services page
    Then it shows a form with name, email, organization, and a field for what resources to integrate
    When they submit the form
    Then a contact lead is recorded with type professional_services
    And a contact_services conversion event is fired

  Scenario: a professional training contact form exists at /contact/training
    Given a visitor on the contact training page
    Then it shows a form with name, email, organization, team size, and topics of interest
    When they submit the form
    Then a contact lead is recorded with type professional_training
    And a contact_training conversion event is fired

  Scenario: the contact forms are reachable from the beta page
    Given the beta pitch page
    Then it links to /contact/services
    And it links to /contact/training
