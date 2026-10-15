Feature: Customer computer host Front Door
  As a household member
  I want the summoned customer computer host to use the Front Door only
  So that the host runs browser tools without Anthus Dynamo credentials

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP

  Scenario: A customer computer host records boot readiness through the Front Door
    Given tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" household computer is stopped
    When the customer computer host boots through the Front Door worker plane
    Then tenant "anthus" household computer readiness reports model before browser
    And tenant "anthus" household computer readiness reports browser ready

  Scenario: A customer computer host discovers a continuation turn without SQS
    Given a fenced computer handoff with a queued continuation job
    When the customer computer host discovers a computer job through the Front Door
    Then the discovered computer job matches the queued continuation job

  Scenario: A customer computer host completes browser_open without Dynamo credentials
    Given a fenced computer handoff with a queued continuation job
    When the customer computer host runs one browser_open job through the Front Door
    Then the turn journal records tool.result for the pending action id
    And the pull worker leaves no unresolved tool calls
