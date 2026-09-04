Feature: Marketing wiki

  Scenario: The wiki is linked from the footer Product group
    Given the chattic.us home page
    Then the footer lists Wiki linking to "/wiki"
    And the News group does not list Wiki

  Scenario: Product docs in the footer are wiki pages
    Given the chattic.us home page
    Then the footer lists Product model linking to "/wiki/product"
    And the footer lists Roadmap linking to "/wiki/roadmap"
    And the footer lists Architecture linking to "/wiki/architecture"
    And the footer lists Free and Open-Source linking to "/wiki/license"
    And the footer does not link Product model to a GitHub blob

  Scenario: Wiki index is a durable notes desk with published pages
    Given a visitor on the wiki page
    Then the page states that the wiki is durable notes about agent workplaces
    And the page describes general ideas
    And the page lists "Agent workplace" linking to "/wiki/agent-workplace"
    And the page lists "Product model" linking to "/wiki/product"
    And the page does not say coming soon
    And the page is not marked noindex

  Scenario: An idea page is a Markus wiki article
    Given a visitor on the wiki page "agent-workplace"
    Then the page is titled "Agent workplace"
    And the article is a Markus document
    And the article uses the Chatticus Markus theme

  Scenario: The product model is a wiki page, not a GitHub blob
    Given a visitor on the wiki page "product"
    Then the page is titled "Product model"
    And the article is a Markus document
    And the article uses the Chatticus Markus theme
    And the page states that named teammates share one computer

  Scenario: Founding posts point at wiki pages
    Given a visitor on the Updates post "the-workplace"
    Then the page links to "/wiki/product"
    And the page does not link to a GitHub blob of PRODUCT.md
    Given a visitor on the Updates post "nothing-bills"
    Then the page links to "/wiki/design-challenges"
    And the page links to "/wiki/messaging"
