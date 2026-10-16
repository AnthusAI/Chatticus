Feature: Members see what their organization's bots cost in the web workspace
  As a member of an organization
  I want the workspace to show what the bots cost, by bot, conversation and model, down to each model call
  So that I can see where the spend goes, and trust a number only when it is a whole number

  The view reads the cost routes of host-protocol/src/costs.ts. These scenarios run the real Costs controller and the
  real rendered views against a fake cost API that validates everything it sends with those schemas, with a fixed
  clock (12 October 2026). Money is model token cost at published list prices, never a bill. A figure that leaves out
  a call with no price is never shown as a total: it says "at least" and "incomplete".

  # ---------------------------------------------------------------- the organization summary

  @web
  Scenario: The Costs tab opens on the month so far with the API's total
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls           |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0001852       |
      | t2   | Pi  | Planning | gpt-5.4-mini | 0.0003, 0.0004  |
      | t3   | Ada | Support  | gpt-5.4      | 0.0125          |
    When the member opens the Costs tab
    Then the cost view shows the period "October 2026"
    And the cost headline reads "$0.0134"
    And the cost view says "3 turns"
    And the cost view says "4 model calls"
    And the cost view says "Model token cost at published list prices. This is not a bill."
    And the cost view does not say "incomplete"
    And the cost view asked the cost API for "/costs" without a date range

  @web
  Scenario: Sub-cent spend is never rounded to zero
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls     |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0000185 |
    When the member opens the Costs tab
    Then the cost headline reads "$0.0000185"
    And the turn row "t1" says "$0.0000185"

  @web
  Scenario: The breakdown by bot, conversation and model shows the API's numbers
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls           |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0001852       |
      | t2   | Pi  | Planning | gpt-5.4-mini | 0.0003, 0.0004  |
      | t3   | Ada | Support  | gpt-5.4      | 0.0125          |
    When the member opens the Costs tab
    Then the "bot" breakdown lists "Ada" as "$0.0125"
    And the "bot" breakdown lists "Pi" as "$0.0009"
    And the "channel" breakdown lists "Planning" as "$0.0009"
    And the "channel" breakdown lists "Support" as "$0.0125"
    And the "model" breakdown lists "gpt-5.4-mini" as "$0.0009"
    And the "model" breakdown lists "gpt-5.4" as "$0.0125"
    And the "bot" breakdown lists "Ada" before "Pi"

  @web
  Scenario: The recent turns are listed newest first with their cost
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls     |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0001852 |
      | t2   | Ada | Support  | gpt-5.4      | 0.0125    |
    When the member opens the Costs tab
    Then the recent turns start with "t2" then "t1"
    And the turn row "t2" says "Ada"
    And the turn row "t2" says "Support"
    And the turn row "t2" says "$0.0125"

  @web
  Scenario: A past month is read with its own date range
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  | month   |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002 | 2026-10 |
      | t0   | Pi  | Planning | gpt-5.4-mini | 0.0007 | 2026-09 |
    When the member opens the Costs tab
    And the member goes to the previous month
    Then the cost view shows the period "September 2026"
    And the cost headline reads "$0.0007"
    And the cost view asked the cost API for "/costs" from "2026-09-01" to "2026-09-30"
    When the member goes to the next month
    Then the cost headline reads "$0.0002"

  # ---------------------------------------------------------------- honest states

  @web
  Scenario: A total that leaves out an unpriced call is never shown as complete
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls            |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0003           |
      | t2   | Pi  | Planning | mystery-1    | unpriced         |
    When the member opens the Costs tab
    Then the cost headline reads "at least $0.0003"
    And the cost view says "incomplete: 1 unpriced call"
    And the "bot" breakdown lists "Pi" as "at least $0.0003"
    And the turn row "t2" says "incomplete: 1 unpriced call"
    And the turn row "t1" does not say "incomplete"

  @web
  Scenario: Several unpriced calls are counted
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model     | calls                |
      | t1   | Pi  | Planning | mystery-1 | unpriced, unpriced   |
      | t2   | Pi  | Planning | mystery-2 | unpriced             |
    When the member opens the Costs tab
    Then the cost view says "incomplete: 3 unpriced calls"
    And the cost headline reads "at least $0.00"

  @web
  Scenario: Estimated and gateway-sourced rows are labelled
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  | source    |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0003 | session   |
      | g1   |     |          | gpt-5.4-mini | 0.0002 | estimated |
      | g2   |     |          | gpt-5.4-mini | 0.0001 | gateway   |
    When the member opens the Costs tab
    Then the turn row "g1" says "estimated"
    And the turn row "g1" says "gateway"
    And the turn row "g2" says "gateway"
    And the turn row "g2" does not say "estimated"
    And the turn row "t1" does not say "gateway"
    And the cost view says "1 estimated row"
    And the cost view says "2 rows seen only by the model gateway"

  @web
  Scenario: A turn that is still running says its figure may grow
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  | status    |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0003 | completed |
      | t2   | Pi  | Planning | gpt-5.4-mini | 0.0001 | running   |
    When the member opens the Costs tab
    Then the cost view says "1 turn is still running, so the total may grow"
    And the turn row "t2" says "running"

  @web
  Scenario: An organization with no spend this month says so
    Given the cost view for "ryan@example.com" in "Anthus Labs" with no turns
    When the member opens the Costs tab
    Then the cost view says "No model spend recorded for October 2026."
    And the cost view does not say "incomplete"

  @web
  Scenario: A failed read says so and can be tried again
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0003 |
    And the cost API fails on the next request
    When the member opens the Costs tab
    Then the cost view says "Could not load the costs. Try again."
    And the cost view shows no total
    When the member chooses Try again
    Then the cost headline reads "$0.0003"

  @web
  Scenario: Someone who is not a member of the organization is refused with plain words
    Given the cost view for "eve@example.com" in "Anthus Labs" who is not a member
    When the member opens the Costs tab
    Then the cost view says "Only members of this organization can see its costs."
    And the cost view shows no total

  # ---------------------------------------------------------------- pagination and export

  @web
  Scenario: More turns are loaded a page at a time
    Given the cost view for "ryan@example.com" in "Anthus Labs" with 120 turns of "0.001" this month
    When the member opens the Costs tab
    Then the recent turns list shows 50 turns
    And the cost view says "Showing 50 of 120 turns"
    When the member chooses Show more turns
    Then the recent turns list shows 100 turns
    And the cost API was asked for turns with the cursor it issued
    When the member chooses Show more turns
    Then the recent turns list shows 120 turns
    And the cost view offers no Show more turns

  @web
  Scenario: The costs of the range download as CSV
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0003 |
    When the member opens the Costs tab
    And the member chooses Download turns as CSV
    Then the cost API was asked to export "csv" at the "turn" grain with the member's token
    And the member is handed the file "costs-2026-10-01-2026-10-12-turn.csv"
    And the cost view says "Downloaded costs-2026-10-01-2026-10-12-turn.csv"

  # ---------------------------------------------------------------- the per-turn drill-down

  @web
  Scenario: A turn opens to the model calls that made it up
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls           |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0003, 0.0001852 |
    When the member opens the Costs tab
    And the member opens the turn "t1"
    Then the call list shows 2 calls
    And call 1 of the turn shows "gpt-5.4-mini"
    And call 1 of the turn shows "$0.0003"
    And call 1 of the turn shows "1,200 input"
    And call 1 of the turn shows "800 cached read"
    And call 1 of the turn shows "100 cache write"
    And call 1 of the turn shows "300 output"
    And call 1 of the turn shows "standard tier"
    And call 1 of the turn shows "openai@2026-10-11"
    And call 2 of the turn shows "$0.0001852"
    And the cost view says "Model token cost at published list prices. This is not a bill."

  @web
  Scenario: An unpriced call in a turn is labelled and not counted as zero
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls                      |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002, mystery-1:unpriced |
    When the member opens the Costs tab
    And the member opens the turn "t1"
    Then call 2 of the turn shows "unpriced"
    And call 2 of the turn does not show "$0"
    And the cost view says "incomplete: 1 unpriced call"

  @web
  Scenario: A turn whose calls cannot be read says so and still shows its total
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0003 |
    And the session of turn "t1" cannot be read
    When the member opens the Costs tab
    And the member opens the turn "t1"
    Then the cost view says "The model calls of this turn could not be read."
    And the cost view says "$0.0003"

  @web
  Scenario: The drill-down can be closed
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0003 |
    When the member opens the Costs tab
    And the member opens the turn "t1"
    And the member goes back to the turns
    Then the recent turns list shows 1 turn

  # ---------------------------------------------------------------- the conversation

  @web
  Scenario: The conversation header shows the session total
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  | prompt | reply |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002 | 1      | 2     |
      | t2   | Pi  | Planning | gpt-5.4-mini | 0.0004 | 3      | 4     |
      | t3   | Ada | Support  | gpt-5.4      | 0.5    | 1      | 2     |
    When the member opens the "Planning" conversation
    Then the conversation cost chip shows "$0.0006"
    And the cost API was asked for the cost of the channel "Planning"

  @web
  Scenario: The conversation header shows the session's turns and tokens beside its cost
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  | prompt | reply |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002 | 1      | 2     |
      | t2   | Pi  | Planning | gpt-5.4-mini | 0.0004 | 3      | 4     |
    When the member opens the "Planning" conversation
    Then the conversation cost chip shows "$0.0006"
    And the conversation cost chip shows "2 turns · 4,800 tokens · 38% cached"

  @web
  Scenario: The chip of a conversation with an unpriced call is not a total
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls                      | prompt | reply |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002, mystery-1:unpriced | 1      | 2     |
    When the member opens the "Planning" conversation
    Then the conversation cost chip shows "at least $0.0002"
    And the conversation cost chip shows "incomplete"

  @web
  Scenario: Each message shows what it triggered and what it took
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  | prompt | reply |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002 | 1      | 2     |
      | t2   | Pi  | Planning | gpt-5.4-mini | 0.0004 | 3      | 4     |
    When the member opens the "Planning" conversation
    Then message 1 shows the cost marker "Triggered $0.0002"
    And message 2 shows the cost marker "Took $0.0002"
    And message 3 shows the cost marker "Triggered $0.0004"
    And message 4 shows the cost marker "Took $0.0004"

  @web
  Scenario: A reply shows the model and the tokens behind it, and its prompt does not repeat them
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls          | prompt | reply |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002, 0.0001 | 1      | 2     |
    When the member opens the "Planning" conversation
    Then message 2 shows the cost marker "Took $0.0003"
    And message 2 shows the cost marker "gpt-5.4-mini · 4,200 in · 600 out · 38% cached"
    And message 1 shows the cost marker "Triggered $0.0003"
    And message 1 does not show the cost marker "in ·"

  @web
  Scenario: A message with no recorded cost shows no marker
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  | prompt | reply |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002 | 1      | 2     |
    When the member opens the "Planning" conversation
    Then message 5 shows no cost marker

  @web
  Scenario: A message marker with an unpriced call is not shown as a total
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls                      | prompt | reply |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002, mystery-1:unpriced | 1      | 2     |
    When the member opens the "Planning" conversation
    Then message 2 shows the cost marker "Took at least $0.0002"
    And message 2 shows the cost marker "incomplete"

  @web
  Scenario: Opening a message marker shows the model calls of its turn
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls            | prompt | reply |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002, 0.0001   | 1      | 2     |
    When the member opens the "Planning" conversation
    And the member opens the cost of message 2
    Then the call list shows 2 calls
    And the cost API was asked for the cost of the turn "t1"

  @web
  Scenario: A message that several turns triggered lists them
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  | prompt | reply |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002 | 1      | 2     |
      | t2   | Ada | Planning | gpt-5.4      | 0.0010 | 1      | 3     |
    When the member opens the "Planning" conversation
    Then message 1 shows the cost marker "Triggered $0.0012"
    When the member opens the cost of message 1
    Then the recent turns list shows 2 turns

  @web
  Scenario: The Costs tab can be scoped to the open conversation
    Given the cost view for "ryan@example.com" in "Anthus Labs" with these turns this month
      | turn | bot | channel  | model        | calls  | prompt | reply |
      | t1   | Pi  | Planning | gpt-5.4-mini | 0.0002 | 1      | 2     |
      | t3   | Ada | Support  | gpt-5.4      | 0.5    | 1      | 2     |
    When the member opens the "Planning" conversation
    And the member opens the Costs tab
    And the member chooses this conversation
    Then the cost headline reads "$0.0002"
    And the recent turns list shows 1 turn
    And the "bot" breakdown lists "Pi" as "$0.0002"
    And the cost view says "Planning"
    When the member chooses the whole organization
    Then the cost headline reads "$0.5002"
