Feature: Chromium host executor
  As a household member
  I want browser tools executed on the summoned computer host
  So that the Lambda computer queue does not fake tool.result

  Background:
    Given an empty control plane

  Scenario: A computer-capable pull worker commits browser_open with a chromium executor
    Given a fenced computer handoff with a queued continuation job
    And the computer host has booted through the browser gate
    When a computer-capable pull worker with a chromium executor pulls that continuation job
    Then the turn journal records tool.result for the pending action id
    And the pull worker leaves no unresolved tool calls
    And the computer continuation job is removed from the queue

  Scenario: A chromium executor refuses an unsupported browser tool
    Given a fenced computer handoff with a queued continuation job
    And the computer host has booted through the browser gate
    When a chromium executor runs an unsupported browser tool
    Then the chromium executor reports the tool is unsupported

  Scenario: Two pull workers cannot double-commit tool.result for one browser-waiting turn
    Given a browser-waiting turn with a queued continuation job
    And the computer host has booted through the browser gate
    And one computer continuation job is delivered twice
    When two computer-capable pull workers with a host executor pull that continuation concurrently
    Then the turn journal records exactly one tool.result for the pending action id
    And the host executor ran the pending action once
    And the computer continuation job is removed from the queue
