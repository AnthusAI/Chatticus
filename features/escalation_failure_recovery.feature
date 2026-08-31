Feature: Escalation failure recovery
  As a household member
  I want escalation failures to recover deterministically
  So that a browser is never held forever and an action is never performed twice

  Background:
    Given an empty control plane

  Scenario Outline: Failure during computer handoff
    Given a computerless turn is ready to request a computer tool
    When its worker stops <boundary>
    Then the pending call is either continued exactly once or the turn ends visibly
    And only one attempt can control the computer
    And an orphaned computer claim expires

    Examples:
      | boundary |
      | before the tool call is committed |
      | after the tool call is committed but before enqueue |
      | after enqueue but before relinquishing ownership |
      | after the computer action but before its result is committed |
