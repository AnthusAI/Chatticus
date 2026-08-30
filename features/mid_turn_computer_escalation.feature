Feature: Mid-turn computer escalation
  As a household member
  I want a bot to gain computer capability without restarting its reasoning
  So that completed work and paid model output are preserved

  Background:
    Given an empty control plane

  Scenario: A computerless turn requests its first computer tool
    Given a computerless attempt has committed model output and one pending computer tool call
    When the household computer becomes ready
    Then one computer-capable attempt executes that exact pending call
    And the tool result is appended to the same turn
    And the model continues after the result
    And no completed tool result is replayed
