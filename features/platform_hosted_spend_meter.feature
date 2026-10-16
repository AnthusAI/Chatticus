Feature: A platform-hosted organization's spend is measured from its own computer's runtime
  As the operator of the deployment account
  I want the spend ceiling of an organization hosted in my account to be checked against what its computer really cost
  So that the brake works without cost allocation tags and an unmeasured organization never reads as free

  An organization hosted in the platform account has no AWS account of its own to
  read, and Cost Explorer cannot split the platform account's bill by
  organization: the cost allocation tags that would do it cannot be activated from
  a member account. The control plane already knows how long each organization's
  computer owner ran, because it records when the owner started and every poll
  after it. The daily rollup prices those seconds at the published Fargate ARM64
  rate for a 0.25 vCPU, 0.5 GiB task: 0.009875 USD per hour, with a one-minute
  minimum per owner run, the way Fargate bills. It is an approximation and says
  so: snapshot storage and the stack's shared costs are not in it, and the last
  seconds before a poll are not counted. It is a figure for the organization's
  computer, not the invoice. An organization in its own AWS account is still read
  through its own account and is not touched by this meter.

  Background:
    Given a daily budget rollup harness for environment "development"
    And the account monthly budget limit is 100 USD
    And organization "Anthus Labs" with tenant "anthus" is enabled
    And organization "Other House" with tenant "other-org" is enabled

  Scenario: Computer runtime is priced at the Fargate ARM64 rate
    Given the computer of tenant "anthus" ran for 3 hours on 2026-08-31
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has aws_cost_usd 0.029625
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has ce_status "ok"

  Scenario: Only the part of a run inside the rollup day counts
    Given the computer of tenant "anthus" ran from 2026-08-30T22:00:00Z to 2026-08-31T02:00:00Z
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has aws_cost_usd 0.01975
    When the daily budget rollup runs for 2026-08-30
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-30 has aws_cost_usd 0.01975

  Scenario: Several runs in one day add up
    Given the computer of tenant "anthus" ran for 1 hour on 2026-08-31
    And the computer of tenant "anthus" ran from 2026-08-31T10:00:00Z to 2026-08-31T12:00:00Z
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has aws_cost_usd 0.029625

  Scenario: A very short run is billed for Fargate's one-minute minimum
    Given the computer of tenant "anthus" ran for 10 seconds on 2026-08-31
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has aws_cost_usd 0.00016458

  Scenario: An organization whose computer never ran spent nothing and is measured
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has aws_cost_usd 0
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has ce_status "ok"

  Scenario: One organization's computer is not charged to another
    Given the computer of tenant "anthus" ran for 2 hours on 2026-08-31
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "other-org" environment "development" on 2026-08-31 has aws_cost_usd 0

  Scenario: Runtime records that cannot be read make the meter unknown, never zero
    Given the runtime records of the computer of tenant "anthus" are unreadable
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has null aws_cost_usd
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has ce_status "error"
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has null combined_report_usd

  Scenario: An unreadable platform-hosted organization does not stop the others
    Given the runtime records of the computer of tenant "anthus" are unreadable
    And the computer of tenant "other-org" ran for 1 hour on 2026-08-31
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has ce_status "error"
    And the budget rollup for tenant "other-org" environment "development" on 2026-08-31 has aws_cost_usd 0.009875

  Scenario: An organization in its own AWS account keeps its own meter
    Given organization "Acme" with tenant "acme" runs in its own AWS account
    And its own account spent 12.50 USD on 2026-08-31
    And the computer of tenant "acme" ran for 3 hours on 2026-08-31
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "acme" environment "development" on 2026-08-31 has aws_cost_usd 12.50
