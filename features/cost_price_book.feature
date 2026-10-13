Feature: A versioned price book prices every model call
  As the operator of an organization computer
  I want each model call priced from a versioned vendor price book
  So that the dollars I see account for cached input, long contexts and the model of each call

  The price book names its source and version, and every ledger row records the
  version that priced it. A call is priced by its own model, its cached input
  reads and writes are priced at the cache rates, and its context size selects
  the price tier. A model the book does not know is never priced as zero: a turn
  on it fails before the model is called, and a spend record of it is marked
  unpriced with unknown dollars.

  Background:
    Given an empty control plane backed by a durable messaging store
    And tenant "anthus" user "ryan" has a bot named "Helper"
    And the default vendor prices of the production compositions are in force

  Scenario: Cached input reads are priced at the cache read rate
    Given the model "gpt-6-luna" answers "Cached hello" using 1000 uncached input, 4000 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello cache"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    Then the vendor ledger row for the turn has input tokens 5000
    And the vendor ledger row for the turn has cost_usd 0.00024
    And the vendor ledger row for the turn was priced with "list"

  Scenario: Cached input writes are priced at the cache write rate
    Given the model "gpt-6-luna" answers "Cache write hello" using 1000 uncached input, 0 cache read, 2000 cache write and 100 output tokens
    When bot "Helper" is asked "hello cache write"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    Then the vendor ledger row for the turn has cost_usd 0.0004

  Scenario: A context above the long-context threshold is priced at the tier rates
    Given the model "gpt-6-luna" answers "Long hello" using 100000 uncached input, 150000 cache read, 50000 cache write and 1000 output tokens
    When bot "Helper" is asked "hello long context"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    Then the vendor ledger row for the turn has cost_usd 0.03625
    And the vendor ledger row for the turn was priced with "long_context_tier"

  Scenario: A context at the threshold is still priced at the base rates
    Given the model "gpt-6-luna" answers "Threshold hello" using 100000 uncached input, 150000 cache read, 22000 cache write and 1000 output tokens
    When bot "Helper" is asked "hello threshold"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    Then the vendor ledger row for the turn has cost_usd 0.01475
    And the vendor ledger row for the turn was priced with "list"

  Scenario: A turn that switches model prices each call at the model of that call
    Given the model "gpt-6-luna" calls the note tool with "checking" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    And the model "gpt-6-luna" then answers "Done" as served by "gpt-5-nano" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello two models"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    Then the vendor ledger row for the turn has cost_usd 0.00024
    And the vendor ledger row for the turn lists models "gpt-5-nano, gpt-6-luna"

  Scenario: The ledger row records the price book version that priced it
    Given the model "gpt-6-luna" answers "Versioned hello" using 1000 uncached input, 0 cache read, 0 cache write and 100 output tokens
    When bot "Helper" is asked "hello version"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-6-luna"
    Then the vendor ledger row for the turn has price book id "openai@2026-10-13+pi-ai-1.0.2"

  Scenario: A price without cache rates falls back to the input rate and says so
    Given vendor price for model "no-cache-rates-model" is 2.00 input and 4.00 output per million tokens
    And the model "no-cache-rates-model" answers "Fallback hello" using 1000 uncached input, 500 cache read, 0 cache write and 200 output tokens
    When bot "Helper" is asked "hello fallback"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "no-cache-rates-model"
    Then the vendor ledger row for the turn has cost_usd 0.0038
    And the vendor ledger row for the turn was priced with "uncached_fallback"

  Scenario: A turn on a model the price book does not know fails before the model is called
    Given the model "gpt-9-unpriced" answers "Never said"
    When bot "Helper" is asked "hello unpriced"
    And bot "Helper" runs one vendor-ledger computerless worker turn with model "gpt-9-unpriced" that fails
    Then the turn has failed with reason "No price is tabled for model openai/gpt-9-unpriced in price book openai@2026-10-13+pi-ai-1.0.2, so the turn was not run."
    And the model "gpt-9-unpriced" was called 0 times

  Scenario: A spend record of an unknown model is marked unpriced and carries no dollars
    When vendor spend is recorded for turn "unpriced-turn" with model "gpt-9-unpriced" and tokens 100 in 50 out
    Then the vendor ledger row for turn "unpriced-turn" has input tokens 100
    And the vendor ledger row for turn "unpriced-turn" has null cost_usd
    And the vendor ledger row for turn "unpriced-turn" has 1 unpriced call
