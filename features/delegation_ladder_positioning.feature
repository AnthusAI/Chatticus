Feature: Delegation ladder positioning

  Scenario: The home page argues control
    Given the chattic.us home page
    Then it states that the deployment runs in infrastructure the customer controls
    And it states that the source can be read, forked, and changed

  Scenario: The home page argues access to the developers
    Given the chattic.us home page
    Then it states that Anthus runs its own organizations on Chatticus
    And it states that managed customers run what Anthus runs

  Scenario: The home page states where the computer runs
    Given the chattic.us home page
    Then it states that the organization computer runs in an AWS account the customer controls
    And it states that the source is available under an open licence
