Feature: Members read what the bots cost, per turn, message, channel, bot, member, model and month

  As a member of an organization
  I want to read what the organization's bots cost, at every level, from the Front Door
  So that spend is something I can see and check, not something I am told

  The cost API is read-only. It reads the turn index of the cost accounting epic
  (docs/COST_ACCOUNTING.md sections 3.8, 3.9 and 3.10): one item per turn in the
  month partition of the organization, written by the owner from the session's call
  records, plus the rows the gateway reconciliation adds for calls the session never
  committed. The turn drill-down reads the call records from the session itself. The
  wire shapes are in host-protocol/src/costs.ts.

  Every enabled member of the organization may read the organization's cost: it is
  their own spend. A caller who is not a member of the organization in the path is
  refused, whatever organization they belong to. Every figure is the sum of its parts:
  the cost of a channel is the sum of its turns, and the groups of any rollup add up to
  the total they split. A call with no price is never counted as zero: the totals
  carry the number of unpriced calls and no overall dollar figure.

  Background:
    Given an empty control plane backed by a durable messaging store
    And tenant "anthus" user "ryan" has a bot named "Helper"
    And tenant "anthus" user "mia" has a bot named "Scout"
    And user "pat" is an ordinary member of tenant "anthus"
    And the default vendor prices of the production compositions are in force

  Scenario: A turn's cost lists its calls with tokens, model, price book and dollars
    Given the model "gpt-6-luna" calls the note tool with "checking" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" answers "Done" using 2000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello drill down"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And member "ryan" gets the cost of the turn
    Then the cost response status is 200
    And the cost response is private and not stored
    And the response field "row.status" is "completed"
    And the response field "row.owner_kind" is "lambda"
    And the response field "row.source" is "session"
    And the response field "row.estimated" is "false"
    And the response field "totals.calls" is "2"
    And the response field "totals.input_tokens" is "3000"
    And the response field "totals.cache_read_tokens" is "4000"
    And the response field "totals.output_tokens" is "300"
    And the response field "totals.cost_usd" is "0.00049"
    And the response field "totals.complete" is "true"
    And the response field "totals.price_book_ids.0" is "openai@2026-10-13+pi-ai-1.0.2"
    And the response field "calls_available" is "true"
    And the response list "calls" has 2 items
    And the response field "calls.0.round" is "1"
    And the response field "calls.0.model" is "gpt-6-luna"
    And the response field "calls.0.input_tokens" is "1000"
    And the response field "calls.0.output_tokens" is "100"
    And the response field "calls.0.cost_usd" is "0.00015"
    And the response field "calls.0.price_book_id" is "openai@2026-10-13+pi-ai-1.0.2"
    And the response field "calls.0.tier" is "standard"
    And the response field "calls.1.round" is "2"
    And the response field "calls.1.cache_read_tokens" is "4000"
    And the response field "calls.1.cost_usd" is "0.00034"
    And the calls of the response add up to its totals

  Scenario: A turn that switches model reports each model's share
    Given the model "gpt-6-luna" calls the note tool with "checking" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" then answers "Done" as served by "gpt-5-nano" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello two models"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And member "ryan" gets the cost of the turn
    Then the response field "totals.cost_usd" is "0.00024"
    And the response list "totals.by_model" has 2 items
    And the response field "totals.by_model[model=gpt-5-nano].priced_cost_usd" is "0.00009"
    And the response field "totals.by_model[model=gpt-6-luna].priced_cost_usd" is "0.00015"
    And the response field "totals.by_model[model=gpt-6-luna].calls" is "1"

  Scenario: A message shows the cost it triggered and the cost of producing its reply
    Given the model "gpt-6-luna" answers "Reply" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello message cost"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And member "ryan" gets the cost of the prompt message of the channel
    Then the response field "triggered.totals.cost_usd" is "0.00015"
    And the response list "triggered.rows" has 1 items
    And the response field "produced.totals.cost_usd" is "0"
    And the response list "produced.rows" has 0 items
    When member "ryan" gets the cost of the reply message of the channel
    Then the response field "produced.totals.cost_usd" is "0.00015"
    And the response list "produced.rows" has 1 items
    And the response field "triggered.totals.cost_usd" is "0"

  Scenario: A channel's cost is the sum of its turns, split by bot and by model
    Given the model "gpt-6-luna" answers "First" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" answers "Second" using 2000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello first"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And bot "Helper" is asked "hello second"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And member "pat" gets the cost of the channel
    Then the cost response status is 200
    And the response field "totals.turns" is "2"
    And the response field "totals.calls" is "2"
    And the response field "totals.cost_usd" is "0.00049"
    And the response list "rows" has 2 items
    And the response field "by_bot.0.key" is the id of bot "Helper"
    And the response field "by_bot.0.totals.cost_usd" is "0.00049"
    And the response field "totals.by_model.0.model" is "gpt-6-luna"
    And the rows of the response add up to its totals

  Scenario: Cost per bot, channel, member and month each add up to the organization total
    Given the model "gpt-6-luna" answers "From Helper" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" answers "From Scout" using 2000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    And the model "gpt-6-luna" answers "From Helper in September" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello august"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And bot "Scout" is asked "hello scout"
    And bot "Scout" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And 172800 seconds pass
    And bot "Helper" is asked "hello september"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And member "pat" gets "/costs?from=2026-08-01&to=2026-09-30"
    Then the response field "totals.turns" is "3"
    And the response field "totals.cost_usd" is "0.00064"
    When member "pat" gets "/costs?from=2026-08-01&to=2026-09-30&group_by=bot"
    Then the response list "groups" has 2 items
    And the response field "groups[key={bot:Helper}].totals.cost_usd" is "0.0003"
    And the response field "groups[key={bot:Scout}].totals.cost_usd" is "0.00034"
    And the groups of the response add up to its totals
    When member "pat" gets "/costs?from=2026-08-01&to=2026-09-30&group_by=channel"
    Then the response list "groups" has 2 items
    And the groups of the response add up to its totals
    When member "pat" gets "/costs?from=2026-08-01&to=2026-09-30&group_by=member"
    Then the response field "groups[key=ryan].totals.cost_usd" is "0.0003"
    And the response field "groups[key=mia].totals.cost_usd" is "0.00034"
    And the groups of the response add up to its totals
    When member "pat" gets "/costs?from=2026-08-01&to=2026-09-30&group_by=month"
    Then the response list "groups" has 2 items
    And the response field "groups[key=2026-08].totals.cost_usd" is "0.00049"
    And the response field "groups[key=2026-09].totals.cost_usd" is "0.00015"
    And the groups of the response add up to its totals
    When member "pat" gets "/costs?from=2026-08-01&to=2026-09-30&group_by=day"
    Then the response list "groups" has 2 items
    And the groups of the response add up to its totals
    When member "pat" gets "/costs?from=2026-08-01&to=2026-09-30&group_by=model"
    Then the response list "groups" has 1 items
    And the response field "groups.0.totals.cost_usd" is "0.00064"
    And the groups of the response add up to its totals

  Scenario: The date range and the bot, channel and member filters narrow the totals
    Given the model "gpt-6-luna" answers "From Helper" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" answers "From Scout" using 2000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    And the model "gpt-6-luna" answers "From Helper in September" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello august"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And bot "Scout" is asked "hello scout"
    And bot "Scout" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And 172800 seconds pass
    And bot "Helper" is asked "hello september"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And member "pat" gets "/costs?from=2026-09-01&to=2026-09-30"
    Then the response field "totals.turns" is "1"
    And the response field "totals.cost_usd" is "0.00015"
    When member "pat" gets "/costs?from=2026-08-31&to=2026-08-31"
    Then the response field "totals.turns" is "2"
    And the response field "totals.cost_usd" is "0.00049"
    When member "pat" gets "/costs?from=2026-08-01&to=2026-09-30&bot_id={bot:Scout}"
    Then the response field "totals.turns" is "1"
    And the response field "totals.cost_usd" is "0.00034"
    When member "pat" gets "/costs?from=2026-08-01&to=2026-09-30&member_id=ryan"
    Then the response field "totals.turns" is "2"
    And the response field "totals.cost_usd" is "0.0003"
    When member "pat" gets "/costs?from=2026-08-01&to=2026-09-30&channel_id={channel}"
    Then the response field "totals.turns" is "2"
    And the response field "filters.channel_id" is the id of the channel
    When member "pat" gets "/costs?from=2026-08-01&to=2026-09-30&bot_id=no-such-bot"
    Then the response field "totals.turns" is "0"
    And the response field "totals.cost_usd" is "0"

  Scenario: Turn rows page through a range once each, newest first
    Given the model "gpt-6-luna" answers "One" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" answers "Two" using 2000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    And the model "gpt-6-luna" answers "Three" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello one"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And 60 seconds pass
    And bot "Scout" is asked "hello two"
    And bot "Scout" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And 60 seconds pass
    And bot "Helper" is asked "hello three"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And member "pat" gets "/costs/turns?limit=2"
    Then the response list "rows" has 2 items
    And the response field "totals.turns" is "3"
    And the response field "next_cursor" is present
    And the turn rows of the response are newest first
    When member "pat" gets "/costs/turns?limit=2&cursor={cursor}"
    Then the response list "rows" has 1 items
    And the response field "next_cursor" is null
    And paging the turn rows 1 at a time visits all 3 turns once and their costs add up to the total
    When member "pat" gets "/costs?group_by=bot&limit=1"
    Then the response list "groups" has 1 items
    And the response field "next_cursor" is present
    When member "pat" gets "/costs?group_by=bot&limit=1&cursor={cursor}"
    Then the response list "groups" has 1 items
    And the response field "next_cursor" is null

  Scenario: A turn that has recorded nothing yet has no row and no calls
    Given the model "gpt-6-luna" answers "Soon" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello open"
    And member "pat" gets the cost of the turn
    Then the cost response status is 200
    And the response field "row" is null
    And the response field "totals.calls" is "0"
    And the response field "totals.cost_usd" is "0"
    And the response list "calls" has 0 items

  Scenario: Export returns the rows with the price book id, as CSV and as NDJSON
    Given the model "gpt-6-luna" calls the note tool with "checking" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" answers "Done" using 2000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello export"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And member "pat" gets "/costs/export?format=csv&grain=turn"
    Then the cost response status is 200
    And the response content type is "text/csv; charset=utf-8"
    And the response header "X-Cost-Price-Book-Ids" is "openai@2026-10-13+pi-ai-1.0.2"
    And the response header "Content-Disposition" contains "costs-2026-08-01-2026-08-31-turn.csv"
    And the export has 1 data line and its "price_book_ids" column is "openai@2026-10-13+pi-ai-1.0.2"
    And the export line 1 has "cost_usd" "0.00049"
    When member "pat" gets "/costs/export?format=ndjson&grain=call"
    Then the response content type is "application/x-ndjson; charset=utf-8"
    And the export has 2 data lines and each has price book "openai@2026-10-13+pi-ai-1.0.2"
    And the export line 2 has "cost_usd" "0.00034"
    And the export line 1 has "model" "gpt-6-luna"

  Scenario: Compare returns the totals and normalized metrics of two channels
    Given the model "gpt-6-luna" answers "From Helper" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" calls the note tool with "checking" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" answers "From Scout" using 2000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello compare one"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And the channel is remembered as "helper channel"
    And bot "Scout" is asked "hello compare two"
    And bot "Scout" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And the channel is remembered as "scout channel"
    And member "pat" compares the remembered channels "helper channel" and "scout channel"
    Then the cost response status is 200
    And the response field "subject" is "channel"
    And the response list "items" has 2 items
    And the response field "items.0.metrics.cost_per_turn_usd" is "0.00015"
    And the response field "items.0.metrics.calls_per_turn" is "1"
    And the response field "items.0.metrics.cached_input_ratio" is "0"
    And the response field "items.1.metrics.calls_per_turn" is "2"
    And the response field "items.1.totals.cost_usd" is "0.00049"
    And the response field "items.1.metrics.cost_per_call_usd" is "0.000245"

  Scenario: Every enabled member may read the organization's cost
    Given the model "gpt-6-luna" answers "Visible" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello visible"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And member "pat" gets "/costs"
    Then the cost response status is 200
    And the response field "totals.cost_usd" is "0.00015"
    When member "mia" gets "/costs"
    Then the response field "totals.cost_usd" is "0.00015"
    When member "pat" gets the cost of the turn
    Then the cost response status is 200
    When member "pat" gets the cost of the channel
    Then the cost response status is 200

  Scenario: Callers who are not members of the organization are refused
    Given the model "gpt-6-luna" answers "Private" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And tenant "other" has user "eve"
    When bot "Helper" is asked "hello private"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And user "eve" of tenant "other" gets "/costs" of tenant "anthus"
    Then the cost response status is 403
    And the cost response is private and not stored
    When user "eve" of tenant "other" gets "/costs/turns" of tenant "anthus"
    Then the cost response status is 403
    When user "eve" of tenant "other" gets "/costs/export" of tenant "anthus"
    Then the cost response status is 403
    When user "eve" of tenant "other" gets "/costs/compare?channel_id={channel}&channel_id={channel}" of tenant "anthus"
    Then the cost response status is 403
    When user "eve" of tenant "other" gets the cost of the channel of tenant "anthus"
    Then the cost response status is 403
    When user "eve" of tenant "other" gets the cost of the turn of tenant "anthus"
    Then the cost response status is 403
    When user "eve" of tenant "other" gets the cost of the prompt message of the channel of tenant "anthus"
    Then the cost response status is 403
    When a caller with no credential gets "/costs" of tenant "anthus"
    Then the cost response status is 403
    When a signed-in stranger with no organization gets "/costs" of tenant "anthus"
    Then the cost response status is 403

  Scenario: Another organization sees only its own cost and cannot reach a turn or channel of this one
    Given the model "gpt-6-luna" answers "Mine" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And tenant "other" has user "eve"
    When bot "Helper" is asked "hello mine"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    And user "eve" of tenant "other" gets "/costs" of tenant "other"
    Then the cost response status is 200
    And the response field "totals.rows" is "0"
    And the response field "totals.cost_usd" is "0"
    When user "eve" of tenant "other" gets the cost of the turn of tenant "other"
    Then the cost response status is 404
    And the response field "error" is "turn_not_found"
    When user "eve" of tenant "other" gets the cost of the channel of tenant "other"
    Then the cost response status is 404
    And the response field "error" is "channel_not_found"

  Scenario: A malformed request is refused with a reason
    When member "pat" gets "/costs?from=2026-13-40"
    Then the cost response status is 400
    And the response field "error" is "invalid_query"
    And the cost response is private and not stored
    When member "pat" gets "/costs?from=2026-09-30&to=2026-09-01"
    Then the cost response status is 400
    When member "pat" gets "/costs?group_by=colour"
    Then the cost response status is 400
    When member "pat" gets "/costs/turns?limit=0"
    Then the cost response status is 400
    When member "pat" gets "/costs/turns?limit=1000"
    Then the cost response status is 400
    When member "pat" gets "/costs/turns?cursor=not-a-cursor"
    Then the cost response status is 400
    When member "pat" gets "/costs?from=2020-01-01"
    Then the cost response status is 400
    When member "pat" gets "/costs/export?format=xml"
    Then the cost response status is 400
    When member "pat" gets "/costs/compare?channel_id=only-one"
    Then the cost response status is 400
