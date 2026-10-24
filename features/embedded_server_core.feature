Feature: Host supplied identity uses the Chatticus conversation core
  A site host supplies its already verified person and private tenant scope;
  Chatticus reuses its message admission and listing domain without accepting
  a client-selected tenant or authenticating through Chatticus.

  Scenario: Send and read one message through the host boundary
    Given a host supplies an authenticated editor for a private conversation
    When the host sends a message through the embedded server API
    Then Chatticus commits one message for that editor
    And the same message is returned by the embedded read endpoint

  Scenario: Reject browser supplied identity and foreign transcript access
    Given a host supplies an authenticated editor for a private conversation
    When the browser claims another editor while sending through the embedded server API
    Then the embedded server refuses the send
    When another host editor reads the private conversation
    Then the embedded server refuses the read
