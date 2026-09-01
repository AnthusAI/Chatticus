Feature: Chatticus brand experience
  Chatticus presents one living organization across its public site and product
  workspace without relying on copied character designs or invented proof.

  Scenario: A visitor meets the Chatticus organization above the fold
    Given the Chatticus marketing experience
    When a visitor opens the marketing page
    Then the hero says "Build the AI organization you control"
    And the hero introduces visible named teammates
    And the hero offers paths to the product and source

  Scenario: A visitor understands how the organization works
    Given the Chatticus marketing experience
    When a visitor explores the product story
    Then the page explains the shared user-controlled computer
    And the page distinguishes skills, routines, review, and approval
    And teammate motion is tied to meaningful work states

  Scenario: The public story uses honest evidence
    Given the Chatticus marketing experience
    When a visitor reaches the evidence section
    Then shipped capabilities are distinguished from intended capabilities
    And the page contains no fabricated customer testimonial
    And third-party product claims include source links

  Scenario: The brand remains usable without wide screens or motion
    Given the Chatticus marketing experience
    When a visitor uses a narrow viewport or prefers reduced motion
    Then primary content remains readable without horizontal scrolling
    And essential meaning does not depend on animation

  Scenario: The product workspace shares the Chatticus identity
    Given the Chatticus product workspace
    When a user selects a named teammate
    Then chat is the primary work surface
    And household tasks remain available as secondary work
    And control-plane diagnostics remain available as secondary status
    And teammate state is communicated with text as well as motion
