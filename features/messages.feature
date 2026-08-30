Feature: Channels and the message store
  As a Chatticus user
  I want conversations stored as append-only messages in channels
  So that bots can talk to me and to each other on one channel
  And files stay on the shared computer instead of in the transcript

  Scenario: A human message addressed to a bot enqueues a turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When tenant "anthus" user "ryan" opens a channel with bots:
      | Researcher |
    And user "ryan" of tenant "anthus" posts "research the top accounts" addressed to bot "Researcher" on the channel
    Then the channel has 1 message
    And the message with seq 1 has body "research the top accounts"
    And bot "Researcher" has 1 pending turn with required capabilities:
      | cpu |

  Scenario: A bot messages another bot on the same channel
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
      | Writer     |
    When user "ryan" of tenant "anthus" posts "research then draft" addressed to bot "Researcher" on the channel
    And bot "Researcher" posts "notes are in /workspace/accounts.md" addressed to bot "Writer" on the channel
    Then the channel has 2 messages
    And the message with seq 1 is from the human "ryan"
    And the message with seq 2 is from bot "Researcher"
    And bot "Writer" has 1 pending turn with required capabilities:
      | cpu |
    And the human can read both messages on the channel

  Scenario: A file handoff is a path in chat and bytes on the computer
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
      | Writer     |
    When bot "Researcher" writes "accounts.md" containing "top ten accounts" on the computer
    And bot "Researcher" posts "wrote /workspace/accounts.md" addressed to bot "Writer" on the channel
    Then bot "Writer" can read "accounts.md" as "top ten accounts" from the computer
    And the message with seq 1 has body "wrote /workspace/accounts.md"

  Scenario: Another tenant cannot post on the channel
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a channel with bots:
      | Researcher |
    When tenant "other" posts "intrusion" on the channel
    Then posting fails because the tenant does not match
    And the channel has 0 messages

  Scenario: Answer a text-only message without starting the computer
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And tenant "anthus" user "ryan" household computer is stopped
    When user "ryan" of tenant "anthus" posts a text-only message addressed to bot "Assistant" on the channel
    Then bot "Assistant" completes one turn
    And the channel contains one durable bot answer
    And tenant "anthus" user "ryan" household computer remains stopped

  Scenario: Reject a cross-tenant channel access attempt
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And another tenant "other" knows the channel identifier
    When tenant "other" tries to post or read on the channel
    Then access is denied
    And the channel is unchanged
