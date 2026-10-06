Feature: Customer organization snapshot bucket
  As a customer organization
  I want my snapshot packs stored in my own AWS account
  So that workplace files never land in Anthus-managed storage

  Background:
    Given the published customer cross-account CloudFormation template

  Scenario: A missing snapshot bucket does not crash the summoned host
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has computer "household-computer"
    And a worker registered as:
      | worker_id   | garage-mac-1       |
      | tenant_id   | anthus             |
      | cost_class  | local              |
      | capabilities| computer,browser   |
      | computer_id | household-computer |
    And CHATTICUS_SNAPSHOT_BUCKET names a bucket that does not exist yet
    When the customer computer host "garage-mac-1" boots through the Front Door worker plane
    Then tenant "anthus" household computer readiness reports workspace ready after model
    And tenant "anthus" household computer readiness reports browser ready after workspace
    And the Front Door received no snapshot hydrate or publish requests
