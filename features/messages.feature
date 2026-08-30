Feature: Threads and the message store
  As a Chatticus user
  I want conversations stored as append-only messages
  So that bots can talk to me and to each other on one thread
  And files stay on the shared computer instead of in the transcript

  Scenario: A human message addressed to a bot enqueues a turn
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    When tenant "anthus" user "ryan" opens a thread with bots:
      | Researcher |
    And user "ryan" of tenant "anthus" posts "research the top accounts" addressed to bot "Researcher"
    Then the thread has 1 message
    And the message with seq 1 has body "research the top accounts"
    And bot "Researcher" has 1 pending turn

  Scenario: A bot messages another bot on the same thread
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    And tenant "anthus" user "ryan" has opened a thread with bots:
      | Researcher |
      | Writer     |
    When user "ryan" of tenant "anthus" posts "research then draft" addressed to bot "Researcher"
    And bot "Researcher" posts "notes are in /workspace/accounts.md" addressed to bot "Writer"
    Then the thread has 2 messages
    And the message with seq 1 is from the human "ryan"
    And the message with seq 2 is from bot "Researcher"
    And bot "Writer" has 1 pending turn
    And the human can read both messages on the thread

  Scenario: A file handoff is a path in chat and bytes on the computer
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Writer"
    And tenant "anthus" user "ryan" has opened a thread with bots:
      | Researcher |
      | Writer     |
    When bot "Researcher" writes "accounts.md" containing "top ten accounts" on the computer
    And bot "Researcher" posts "wrote /workspace/accounts.md" addressed to bot "Writer"
    Then bot "Writer" can read "accounts.md" as "top ten accounts" from the computer
    And the message with seq 1 has body "wrote /workspace/accounts.md"

  Scenario: Another tenant cannot post on the thread
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has opened a thread with bots:
      | Researcher |
    When tenant "other" posts "intrusion" on the thread
    Then posting fails because the tenant does not match
    And the thread has 0 messages
