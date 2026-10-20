Feature: The bot board capability is active only where the board service is configured
  As an operator
  I want the board capability to switch on with one setting per environment
  So that an environment without the board service behaves exactly as it did before, and the capability reaches staging and production only when the owner extends the rollout

  The rollout switch is the environment variable CHATTICUS_KANBUS_API_URL (docs/BOT_BOARDS.md section 5). Where it is set,
  a new bot gets its board and a turn is offered the board tool. Where it is absent, no board service is called, no board
  is provisioned and no board tool is offered. The old task tool is untouched in both cases.

  @server
  Scenario: Without the board service nothing changes
    Given an empty control plane
    When the bot "Assistant" is created in "Anthus Labs"
    Then no request was made to a board service
    And the bot "Assistant" is offered the task tool and not the board tool

  @server
  Scenario: With the board service a turn is offered the board tool beside the task tool
    Given an empty control plane
    And the Kanbus board service is configured for this environment
    When the bot "Assistant" is created in "Anthus Labs"
    Then the board of "Assistant" was provisioned by an empty-bodied configuration write
    And the bot "Assistant" is offered the task tool and the board tool
