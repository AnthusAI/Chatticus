Feature: Capability-gated readiness
  As a household member
  I want the bot to begin useful work while its computer starts
  So that readiness is per capability and waiting is not disguised as progress

  Background:
    Given an empty control plane

  Scenario: A turn needs the browser after preparatory work
    Given the household computer is stopped
    And a turn has useful work that needs no computer before a browser step
    When the addressed bot begins the turn
    Then it performs the computerless work immediately
    And it emits a waiting state naming the computer capability only when blocked
    And it makes no claim that the browser work is complete
    When the household computer becomes ready
    And the turn continues after the browser capability is ready
    Then it continues the same turn after the computer becomes ready
