Feature: Computer host readiness
  As a household member
  I want readiness tracked per capability on the computer host
  So that a turn blocks only on the gate it actually needs

  Background:
    Given an empty control plane

  Scenario: Capability readiness clears independently during host boot
    Given the household computer is stopped
    When the computer host finishes booting through model and workspace gates
    Then model readiness is recorded before browser readiness
    And browser readiness is not recorded until the browser gate clears
