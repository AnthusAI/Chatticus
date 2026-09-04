Feature: Marketing blog

  Scenario: Footer News group lists Updates then Agent Zoo
    Given the chattic.us home page
    Then the footer has a News group
    And the News group lists Updates linking to "/updates"
    And the News group lists Agent Zoo linking to "/agent-zoo"
    And Updates appears before Agent Zoo in that group

  Scenario: Updates index lists founding progress notes
    Given a visitor on the Updates page
    Then the page states that Updates is progress notes about Chatticus itself
    And the page lists "The workplace is the product" linking to "/updates/the-workplace"
    And the page lists "Nothing bills while nobody is working" linking to "/updates/nothing-bills"
    And the page does not say coming soon

  Scenario: Agent Zoo index lists founding category notes
    Given a visitor on the Agent Zoo page
    Then the page is titled Agent Zoo
    And the page states that Agent Zoo covers workplaces where agents collaborate and do useful work
    And the page lists "Nobody agrees what to call this" linking to "/agent-zoo/nobody-agrees"
    And the page lists "A farm of desks" linking to "/agent-zoo/farms-and-desks"
    And the page does not call itself a model zoo
    And the page does not say coming soon

  Scenario: Each index links to the other desk
    Given a visitor on the Updates page
    Then the page links to "/agent-zoo"
    Given a visitor on the Agent Zoo page
    Then the page links to "/updates"

  Scenario: A visitor can read the workplace update
    Given a visitor on the Updates post "the-workplace"
    Then the page is titled "The workplace is the product"
    And the page states that named teammates share one computer

  Scenario: A visitor can read the names Agent Zoo post
    Given a visitor on the Agent Zoo post "nobody-agrees"
    Then the page is titled "Nobody agrees what to call this"
    And the page states that the industry has not settled on a word

  Scenario: A visitor can read the idle-floor update
    Given a visitor on the Updates post "nothing-bills"
    Then the page is titled "Nothing bills while nobody is working"
    And the page states that the computer is summoned when a turn needs it

  Scenario: A visitor can read the farms and desks Agent Zoo post
    Given a visitor on the Agent Zoo post "farms-and-desks"
    Then the page is titled "A farm of desks"
    And the page states that Chatticus is a farm of desks
