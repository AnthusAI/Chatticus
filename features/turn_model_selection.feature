Feature: Interchangeable models selected per turn
  As a Chatticus member
  I want to pick which model runs this turn from every vendor this deployment can call
  So that OpenAI, Bedrock, Anthropic, and Google are interchangeable at the composer

  Scenario: An AWS-only deployment offers Bedrock models
    Given the deployment has Bedrock enabled
    And the deployment has no OpenAI, Anthropic, or Google credentials
    When a member lists available models
    Then the catalog contains only Bedrock models
    And the default model is a Bedrock model

  Scenario: An OpenAI deployment can also offer Bedrock
    Given the deployment has OpenAI credentials
    And the deployment has Bedrock enabled
    When a member lists available models
    Then the catalog contains OpenAI models
    And the catalog contains Bedrock models

  Scenario: A kitchen-sink deployment offers every seeded vendor
    Given the deployment has OpenAI credentials
    And the deployment has Bedrock enabled
    And the deployment has Anthropic credentials
    And the deployment has Google credentials
    When a member lists available models
    Then the catalog contains OpenAI, Bedrock, Anthropic, and Google models

  Scenario: Posting with a selected model stores it on the turn
    Given the deployment has OpenAI credentials
    And the deployment has Bedrock enabled
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel using model "bedrock/anthropic.claude-sonnet-4-5"
    Then the turn records model "bedrock/anthropic.claude-sonnet-4-5"

  Scenario: Posting without a model uses the deployment default
    Given the deployment has OpenAI credentials
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    Then the turn records the deployment default model

  Scenario: Selecting an unavailable model is rejected
    Given the deployment has OpenAI credentials
    And the deployment has no Bedrock, Anthropic, or Google credentials
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel using model "anthropic/claude-sonnet-4-5"
    Then posting fails because the model is not available

  Scenario: A Bedrock turn records billed_via aws and null cost
    Given the deployment has Bedrock enabled
    And vendor price for model "anthropic.claude-sonnet-4-5" is 2.00 input and 4.00 output per million tokens
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel using model "bedrock/anthropic.claude-sonnet-4-5"
    And bot "Assistant" runs one computerless worker turn for the selected model
    Then the vendor ledger row for the turn has billed_via "aws"
    And the vendor ledger row for the turn has null cost_usd
