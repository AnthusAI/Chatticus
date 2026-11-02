Feature: Shared chat in another application
  A host application supplies its conversation and authorization while using
  the same chat presentation and reconnect behavior as Chatticus.

  Scenario: Read and send a message without the Chatticus workspace
    Given an application renders the shared chat with its own conversation
    When its editor sends a message from the composer
    Then the host receives one message and renders its response
    And no Chatticus account, roster or computer is required

  Scenario: Preserve a turn across a disconnected observer
    Given an application observes stored events for one turn
    When the connection ends after its first event
    Then the shared client resumes after that event
    And replayed events are delivered once

  Scenario: Surface a host authentication failure without opening a stream
    Given the host cannot provide current authentication headers
    When the shared client opens a turn observer
    Then the host receives its authentication error
    And no stream request is sent
