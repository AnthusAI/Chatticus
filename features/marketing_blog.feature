Feature: Marketing blog

  Scenario: Footer News group lists Updates then Agent Zoo
    Given the chattic.us home page
    Then the footer has a News group
    And the News group lists Updates linking to "/updates"
    And the News group lists Agent Zoo linking to "/agent-zoo"
    And Updates appears before Agent Zoo in that group

  Scenario: Updates index states it is Chatticus progress notes
    Given a visitor on the Updates page
    Then the page states that Updates is progress notes about Chatticus itself
    And the page lists no articles yet
    And the page does not say coming soon

  Scenario: Agent Zoo index states the category beat
    Given a visitor on the Agent Zoo page
    Then the page is titled Agent Zoo
    And the page states that Agent Zoo covers workplaces where agents collaborate and do useful work
    And the page lists no articles yet
    And the page does not call itself a model zoo
    And the page does not say coming soon

  Scenario: Each index links to the other desk
    Given a visitor on the Updates page
    Then the page links to "/agent-zoo"
    Given a visitor on the Agent Zoo page
    Then the page links to "/updates"
