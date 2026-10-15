Feature: Canonical workspace conversations
  As an organization member
  I want each bot and named group to have a durable channel identity
  So that the workspace lists conversations rather than transient sessions

  Scenario: Reopening an individual bot returns its canonical direct channel
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When tenant "anthus" user "ryan" opens a direct channel with bot "Researcher"
    And a recycled Front Door serves the same messaging store
    And tenant "anthus" user "ryan" opens a direct channel with bot "Researcher"
    Then both direct channel opens return the same channel identifier
    And the direct channel is unnamed with exactly user "ryan" and bot "Researcher"
    And tenant "anthus" user "ryan" lists one direct channel

  Scenario: A named multi-bot channel persists and lists distinctly
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    When tenant "anthus" user "ryan" opens a direct channel with bot "Researcher"
    And tenant "anthus" user "ryan" creates named channel "Applied Research" with bots:
      | Researcher |
      | Writer     |
    And a recycled Front Door serves the same messaging store
    Then tenant "anthus" user "ryan" lists these channel identities:
      | kind   | name             | bots                |
      | direct |                  | Researcher           |
      | named  | Applied Research | Researcher, Writer   |

  Scenario: A migrated direct channel keeps its existing durable identity
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a canonical direct channel already exists under identifier "existing-history"
    When tenant "anthus" user "ryan" opens a direct channel with bot "Researcher"
    Then the direct channel open returns identifier "existing-history"
