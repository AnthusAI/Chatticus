Feature: Marketing primary navigation

  Scenario: section links from the beta page reach home page sections
    Given a visitor on the beta pitch page
    Then the Chatticus home link in the primary navigation goes to the home page top
    And the Organization link in the primary navigation goes to the home page Organization section
    And the Why Chatticus link in the primary navigation goes to the home page Why Chatticus section
    And the Evidence link in the primary navigation goes to the home page Evidence section
    And the FAQ link in the primary navigation goes to the home page FAQ section

  Scenario: section links on the home page use home section anchors
    Given the chattic.us home page
    Then the Chatticus home link in the primary navigation goes to the home page top
    And the Organization link in the primary navigation goes to the home page Organization section
    And the Why Chatticus link in the primary navigation goes to the home page Why Chatticus section
    And the Evidence link in the primary navigation goes to the home page Evidence section
    And the FAQ link in the primary navigation goes to the home page FAQ section
    And the home page has sections for Organization, Why Chatticus, Evidence, and FAQ
