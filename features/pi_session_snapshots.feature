Feature: Pi session snapshots
  As the Chatticus control plane
  I want a cold owner to read one snapshot object plus the commits after it
  So that opening a long conversation does not cost one object read per commit of history

  Background:
    Given a fresh Pi session store
    And a scripted bot that answers question N with "answer N"

  Scenario: Without snapshots a cold owner reads one object per commit that holds an entry
    Given an owner who never writes snapshots holds a conversation of 12 turns
    When a cold owner opens the session and reads the conversation
    Then the cold owner made more than 12 object reads
    And the cold owner read all 12 questions and answers in order

  Scenario: A snapshot written when the owner closes lets a cold owner open a long history with one object read
    Given an owner who writes a snapshot when it closes holds a conversation of 12 turns
    When a cold owner opens the session and reads the conversation
    Then the cold owner made at most 2 object reads
    And the cold owner read all 12 questions and answers in order

  Scenario: Snapshots written on a commit cadence keep a cold open bounded while the owner is still running
    Given an owner who writes a snapshot every 10 commits holds a conversation of 12 turns
    When a cold owner opens the session and reads the conversation
    Then the cold owner made at most 6 object reads
    And the cold owner read all 12 questions and answers in order

  Scenario: The commits made after the last snapshot are read as well
    Given an owner who writes a snapshot when it closes holds a conversation of 6 turns
    And an owner who never writes snapshots continues the conversation for 2 turns
    When a cold owner opens the session and reads the conversation
    Then the cold owner read all 8 questions and answers in order
    And the cold owner made at most 6 object reads

  Scenario: A snapshot never changes the transcript the model sees
    Given an owner who writes a snapshot when it closes holds a conversation of 8 turns
    When a cold owner opens the session and reads the conversation
    And the snapshot is withdrawn from the session
    And a cold owner opens the session and reads the conversation
    Then the first cold read made fewer object reads than the second
    And both cold reads show the model exactly the same messages
    And the cold owner read all 8 questions and answers in order

  Scenario: An owner that opens from a snapshot keeps conversing
    Given an owner who writes a snapshot when it closes holds a conversation of 5 turns
    When a cold owner opens the session and sends question 6
    Then the cold owner receives "answer 6"
    And a second cold owner reads all 6 questions and answers in order

  Scenario: The sweeper removes a superseded snapshot object and keeps the current one
    Given an owner who writes a snapshot every 10 commits holds a conversation of 6 turns
    And the sweeper leaves objects alone for 10 minutes
    And the session has more than 1 snapshot object
    When 11 minutes pass
    And the sweeper sweeps the session
    Then the session has exactly 1 snapshot object
    And a cold owner opens the session and reads the conversation with at most 6 object reads
