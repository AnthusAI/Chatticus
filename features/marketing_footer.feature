Feature: Marketing footer Build links

  Scenario: The license is named in plain language
    Given the chattic.us home page
    Then the footer lists Free and Open-Source linking to the license
    And the footer does not list Vultus avatars
    And the footer does not list Anth.us
