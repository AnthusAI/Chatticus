Feature: Marketing wiki

  Scenario: The wiki is not linked from the footer
    Given the chattic.us home page
    Then the footer does not list a Wiki link
    And the News group does not list Wiki

  Scenario: Wiki index is a durable notes desk with no pages yet
    Given a visitor on the wiki page
    Then the page states that the wiki is durable notes about agent workplaces
    And the page lists no wiki pages yet
    And the page does not say coming soon
    And the page is marked noindex
