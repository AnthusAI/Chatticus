Feature: Daily budget rollup
  As a Chatticus operator
  I want one daily rollup row per organization and environment
  So that AWS and vendor meters combine into one alert stream without double counting

  Background:
    Given a daily budget rollup harness for environment "development"
    And the account monthly budget limit is 100 USD
    And organization "Anthus Labs" with tenant "anthus" is enabled
    And organization "Other House" with tenant "other-org" is enabled

  Scenario: Daily rollup writes org environment and day attribution
    Given Cost Explorer reports 5.00 USD for tenant "anthus" on 2026-08-31
    And vendor spend for tenant "anthus" on 2026-08-31 totals 0.00004 USD
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has aws_cost_usd 5.00
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has vendor_cost_usd 0.00004
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has combined_report_usd 5.00004
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has ce_status "ok"

  Scenario: Combined spend is a report not a third meter
    Given Cost Explorer reports 1.00 USD for tenant "anthus" on 2026-08-31
    And vendor spend for tenant "anthus" on 2026-08-31 totals 2.00 USD
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has aws_cost_usd 1.00
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has vendor_cost_usd 2.00
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has combined_report_usd 3.00

  Scenario: Vendor threshold crossing publishes once to the budgets topic
    Given vendor spend for tenant "anthus" on 2026-08-01 totals 10.00 USD
    And vendor spend for tenant "anthus" on 2026-08-31 totals 45.00 USD
    When the daily budget rollup runs for 2026-08-31
    Then exactly 1 budget threshold alert was published
    And the budget threshold alert has threshold_percent 50
    And the budget threshold alert source is "chatticus.daily_rollup"

  Scenario: A second daily run while still over threshold does not republish
    Given vendor spend for tenant "anthus" on 2026-08-01 totals 10.00 USD
    And vendor spend for tenant "anthus" on 2026-08-31 totals 45.00 USD
    When the daily budget rollup runs for 2026-08-31
    And the daily budget rollup runs for 2026-08-31 again
    Then exactly 1 budget threshold alert was published

  Scenario: AWS Budget alert is recorded without looping rollup messages
    When an AWS Budgets alert arrives for budget "chatticus-monthly-aws" on 2026-08-31
    Then the account budget rollup for 2026-08-31 records an aws_budget_alert
    When a rollup threshold alert message arrives on the budgets topic
    Then the account budget rollup for 2026-08-31 still has 1 aws_budget_alert

  Scenario: PascalCase AWS Budgets payload is recorded
    When a PascalCase AWS Budgets alert arrives for budget "chatticus-monthly-aws" on 2026-08-31
    Then the account budget rollup for 2026-08-31 records an aws_budget_alert

  Scenario: Cost Explorer lag leaves AWS pending without treating it as zero
    Given Cost Explorer has no data for 2026-08-31
    And vendor spend for tenant "anthus" on 2026-08-31 totals 0.00004 USD
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has null aws_cost_usd
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has ce_status "pending"
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has null combined_report_usd
    And no budget threshold alert was published

  Scenario: Cost Explorer quiet day is zero attributed not pending
    Given Cost Explorer returns zero attributed AWS spend on 2026-08-31
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has aws_cost_usd 0.00
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has ce_status "ok"

  Scenario: AWS-billed ledger rows do not double-count vendor dollars
    Given Cost Explorer reports 3.00 USD for tenant "anthus" on 2026-08-31
    And vendor spend for tenant "anthus" on 2026-08-31 includes 1.00 USD billed_via vendor
    And vendor spend for tenant "anthus" on 2026-08-31 includes aws-billed tokens with null dollars
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has aws_cost_usd 3.00
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has vendor_cost_usd 1.00

  Scenario: Re-run updates the same rollup row without duplicating
    Given Cost Explorer reports 5.00 USD for tenant "anthus" on 2026-08-31
    And vendor spend for tenant "anthus" on 2026-08-31 totals 1.00 USD
    When the daily budget rollup runs for 2026-08-31
    And vendor spend for tenant "anthus" on 2026-08-31 totals 2.00 USD
    And the daily budget rollup runs for 2026-08-31 again
    Then there is 1 budget rollup row for tenant "anthus" environment "development" on 2026-08-31
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has vendor_cost_usd 2.00

  Scenario: Cross-tenant Cost Explorer data does not leak
    Given Cost Explorer reports 7.00 USD for tenant "anthus" on 2026-08-31
    When the daily budget rollup runs for 2026-08-31
    Then the budget rollup for tenant "other-org" environment "development" on 2026-08-31 has aws_cost_usd 0.00
    And the budget rollup for tenant "anthus" environment "development" on 2026-08-31 has aws_cost_usd 7.00
