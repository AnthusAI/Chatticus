Feature: Delegation ladder positioning

  Scenario: The home page argues control
    Given the chattic.us home page
    Then it states that the deployment runs in infrastructure the customer controls
    And it states that the source can be read, forked, and changed

  Scenario: The home page argues access to the developers
    Given the chattic.us home page
    Then it states that Anthus runs its own organizations on Chatticus
    And it states that managed customers run what Anthus runs

  Scenario: The home page does not describe organization data as something to export
    Given the chattic.us home page
    Then it does not describe bots, conversations, or files as exportable
    And it does not offer to archive the account as a way to get the data
    And it states that the file system and secrets live in the customer AWS account
    And it does not state that conversations live in the customer AWS account

  Scenario: The home page states where the Chatticus organization runs
    Given the chattic.us home page
    Then it states that the Chatticus organization runs in the customer AWS account
    And it states that the source is available under an open licence

  Scenario: The home page offers four rungs, each with a price
    Given the chattic.us home page
    When I look at the delegated responsibility section
    Then it offers forking and self-deploying at no cost
    And it offers self-setup with managed operation at a monthly price
    And it offers assisted setup with managed operation at a monthly price and a one-time fee
    And it offers professional services as a quote

  Scenario: The managed rungs say what managed means
    Given the delegated responsibility section
    Then the managed rungs state that Anthus keeps the deployment updated
    And they state that Anthus updates its own organizations first

  Scenario: The FAQ explains what stopping payment does
    Given the chattic.us FAQ
    Then it states that the deployment lives in the customer AWS account
    And it states that Anthus stops operating it and deletes nothing

  Scenario: The FAQ explains what managed operation covers
    Given the chattic.us FAQ
    Then it states that Anthus applies updates to managed deployments
    And it states that a customer may move between self-setup and assisted setup
