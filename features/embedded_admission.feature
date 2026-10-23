Feature: Admit a message from another application
  A host supplies its endpoint, current authorization and one stable request
  key for a logical submission. The shared client does not retry on its own.

  Scenario: Retry after a response is lost
    Given a host prepares one message with a stable admission key
    When its first response is lost and the host retries that submission
    Then both requests carry the same key and freshly supplied authorization
    And the host receives the original message and turn identity

  Scenario: Fail closed when the host session expires
    Given a host prepares one message with a stable admission key
    And the host session has expired before submission
    When the host submits its message
    Then the authorization failure reaches the host without a request

  Scenario: Surface a server refusal without fallback
    Given a host prepares one message with a stable admission key
    And the server refuses message admission
    When the host submits its message
    Then the server refusal reaches the host after one request

  Scenario: Refuse a submission without a stable key
    Given a host prepares one message with a stable admission key
    When the host submits without an admission key
    Then the missing key is reported without a request
