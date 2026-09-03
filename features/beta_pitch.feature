Feature: Beta pitch pricing matrix

  Background:
    Given a visitor on the beta pitch page

  Scenario: The page shows four pricing scenarios in a 2x2 matrix
    Then the page shows a management dimension with two options: managed at $20/month or self-hosted at $0/month
    And the page shows an installation dimension with two options: turn-key at $100 once or self-install at $0
    And both the management fee and the installation fee are shown as optional

  Scenario: The page explains what managed service includes
    Then the page states that managed service means Anthus runs the control plane infrastructure
    And the page states that the customer's AWS account, file system, and encrypted secrets stay in the customer's account
    And the page states that managed service covers availability, continuous upgrades, security scanning, privacy safeguards, and ITSM

  Scenario: The page explains what self-hosted means
    Then the page states that self-hosted means the customer runs the control plane themselves in their own AWS account
    And the page states that there is no monthly management fee to Anthus

  Scenario: The page mentions professional services from Anthus AI Solutions
    Then the page shows a blurb for optional professional services
    And the blurb states that Anthus AI Solutions adapts Chatticus to the customer's needs

  Scenario: The page mentions professional training from Anthus AI Solutions
    Then the page shows a blurb for optional professional training
    And the blurb states that training is available from Anthus AI Solutions

  Scenario: The page mentions bringing your own AI API accounts
    Then the page states that the customer brings their own AWS account
    And the page states that the customer may bring their own AI API accounts
    And the page lists OpenAI, Anthropic, xAI, DeepSeek, Moonshot, and Amazon Bedrock as options
