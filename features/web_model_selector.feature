Feature: Workspace model selector
  As a Chatticus member
  I want the workspace to list this deployment's models and send the one I pick
  So that each turn can use a different vendor without leaving the conversation

  Scenario: The workspace lists models from the front door
    Given an empty control plane
    And the deployment has OpenAI credentials
    And the deployment has Bedrock enabled
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When the web UI requests available models for tenant "anthus"
    Then the web UI model list includes "openai/gpt-5.6-luna"
    And the web UI model list includes "bedrock/anthropic.claude-sonnet-4-5"

  Scenario: The workspace posts the selected model with the message
    Given an empty control plane
    And the deployment has OpenAI credentials
    And the deployment has Bedrock enabled
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    And the web UI composer selects model "bedrock/anthropic.claude-sonnet-4-5"
    When the web UI sends "hello" from user "ryan" of tenant "anthus" addressed to bot "Assistant"
    Then the message is accepted by the thin-turn front door
    And the turn records model "bedrock/anthropic.claude-sonnet-4-5"
