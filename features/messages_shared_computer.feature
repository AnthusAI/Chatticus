Feature: Channels and the shared computer
  As a Chatticus user
  I want files to stay on the shared computer instead of in the transcript
  So that bots hand work to each other as paths in chat

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

  Scenario: A user's computer can be read after a Front Door recycle
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" household computer is stopped
    When a recycled Front Door serves the same messaging store
    Then tenant "anthus" can read the household computer for user "ryan"
