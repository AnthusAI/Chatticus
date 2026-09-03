Feature: Marketing beta pitch

  Scenario: A visitor reaches the beta pitch from the marketing home page
    Given the chattic.us home page
    Then there are calls to action for "/beta"
