Feature: Resuming a waiting turn needs the computer
  As the Chatticus product web app
  I want a waiting turn to refuse a resume while the household computer is stopped
  So that the turn stays parked on its gate instead of running without the computer

  Scenario: Resume is refused while the household computer is stopped
    Given an empty control plane
    And tenant "anthus" user "ryan" household computer is stopped
    And tenant "anthus" user "ryan" has a channel with a named bot "Researcher"
    And user "ryan" of tenant "anthus" has an active turn on the channel
    When the worker posts a progress chunk and then waits on the browser gate
    And user "ryan" of tenant "anthus" tries to resume that waiting turn
    Then resume is refused because the computer is not ready
    And the turn remains active
    And the turn is still waiting on the browser gate
