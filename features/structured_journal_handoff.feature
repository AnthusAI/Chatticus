Feature: Structured journal and fenced computer handoff
  As a household member
  I want continuation from durable typed model and tool events
  So that a recycled worker never re-runs a tool and never loses the pending call

  Background:
    Given an empty control plane

  Scenario: Model request, tool call, result, and attempt transitions are typed journal events
    Given a computerless turn is ready to request a computer tool
    When the computerless attempt records a model request and finishes the fenced handoff
    Then the turn journal has typed model.request, tool.call, tool.result, and attempt events
    And those events are not stored only as token chunks
    And the executed tool action id matches the committed call
    And no unresolved tool calls remain

  Scenario Outline: Failure at a structured handoff boundary recovers from the journal
    Given a computerless turn is ready to request a computer tool
    When the structured handoff worker stops <boundary>
    Then only unresolved tool calls are executed
    And the pending call is either continued exactly once or the turn ends visibly
    And only one attempt can control the computer
    And an orphaned computer claim expires

    Examples:
      | boundary |
      | before the tool call is committed |
      | after the tool call is committed but before enqueue |
      | after enqueue but before relinquishing ownership |
      | after the computer action but before its result is committed |
      | after the computer lease expired before reclamation |

  Scenario: A later attempt reclaims the computer and skips already executed work
    Given a computerless turn is ready to request a computer tool
    When the structured handoff worker stops after the computer lease expired before reclamation
    Then the computer was reclaimed by a later attempt
    And the same action id is not executed twice
