Feature: Bot turns pin to the user's computer
  As a Chatticus user
  I want a bot's turn to run on my computer
  So that files and browser sessions stay on that workplace

  Scenario: A bot turn is assigned to a host of the user's computer
    Given an empty control plane
    And tenant "anthus" user "ryan" has computer "household-computer"
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer     |
      | computer_id | household-computer |
    When bot "Researcher" enqueues a turn:
      | capabilities | computer |
    Then the turn is assigned to worker "garage-mac-1"

  Scenario: A bot turn skips a fresher worker of a different computer
    Given an empty control plane
    And tenant "anthus" user "ryan" has computer "household-computer"
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a worker registered as:
      | worker_id   | garage-mac-1 |
      | tenant_id   | anthus       |
      | cost_class  | local        |
      | capabilities| computer     |
      | computer_id | household-computer |
    And 10 seconds pass
    And a worker registered as:
      | worker_id   | other-mac |
      | tenant_id   | anthus    |
      | cost_class  | local     |
      | capabilities| computer  |
      | computer_id | other-computer |
    When bot "Researcher" enqueues a turn:
      | capabilities | computer |
    Then the turn is assigned to worker "garage-mac-1"
