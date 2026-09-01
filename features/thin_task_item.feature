Feature: Thin task item
  As a household member
  I want durable task state outside the channel transcript
  So that compaction cannot erase job progress and bots can manage tasks without a computer

  Background:
    Given an empty control plane

  Scenario: A bot creates a task from the first readiness gate without summoning a computer
    Given tenant "anthus" user "ryan" has a bot named "Assistant"
    And the household computer is stopped for task work
    When bot "Assistant" uses the task tool to create a task titled "Pay the electric bill"
    Then the task is stored with status "open"
    And the task records bot "Assistant" as provenance
    And no computer was summoned for the task tool

  Scenario: A task cannot reach completed without evidence
    Given tenant "anthus" user "ryan" has a bot named "Assistant"
    And bot "Assistant" has an open task "submit taxes"
    When bot "Assistant" tries to complete the task without evidence
    Then completing the task is refused for missing evidence

  Scenario: A task completes only with system evidence
    Given tenant "anthus" user "ryan" has a bot named "Assistant"
    And bot "Assistant" has an open task "file the return"
    When bot "Assistant" completes the task with evidence "confirmation-id:ret-42"
    Then the task is stored with status "completed"
    And the task evidence is "confirmation-id:ret-42"

  Scenario: A task closes with a recorded reason
    Given tenant "anthus" user "ryan" has a bot named "Assistant"
    And bot "Assistant" has an open task "renew insurance"
    When bot "Assistant" closes the task with reason "household chose another provider"
    Then the task is stored with status "closed"
    And the task close reason is "household chose another provider"

  Scenario: Tasks are isolated by tenant
    Given tenant "anthus" user "ryan" has a bot named "Assistant"
    And bot "Assistant" has an open task "household chore"
    When tenant "other-household" tries to read that task
    Then the task is not visible to the other tenant
