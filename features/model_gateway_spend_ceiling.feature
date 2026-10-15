Feature: The model gateway refuses a call once the organization has spent its monthly model ceiling
  As the operator of an organization
  I want the gateway to stop forwarding model calls when the organization's model spend for the month reaches a ceiling
  So that a runaway bot cannot burn the vendor's money without limit

  The ceiling is per organization and per calendar month (UTC), 25.00 US dollars by
  default. Before it forwards a call the gateway adds up the organization's model
  spend for the current month from the cost index (the turn rows the owner writes
  from the session's call records, and the rows reconciliation adds for calls the
  session never committed). At or above the ceiling the call is refused with the
  error code model_spend_ceiling_reached and never reaches the vendor; the turn then
  fails with a reason a member can read. The figure is as fresh as the cost index,
  so a call that starts under the ceiling may finish over it. If the spend cannot be
  read the call is refused as well (fail closed), with the retryable status 503 and
  the error code model_spend_unavailable. This ceiling is separate from the monthly
  AWS spend ceiling.

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a channel with a named bot "Helper"
    And bot "Helper" has an active turn owned by a container owner
    And the vendor answers "Good morning." using 120 input tokens and 30 output tokens

  Scenario: An organization under its ceiling has its call forwarded
    Given organization "anthus" has spent 24.99 US dollars on models this month
    And the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    Then the gateway answers with status 200
    And the container receives the answer text "Good morning."
    And the vendor received exactly 1 request

  Scenario: An organization at its ceiling is refused with a distinct error code
    Given organization "anthus" has spent 25.00 US dollars on models this month
    And the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    Then the gateway answers with status 403
    And the gateway error code is "model_spend_ceiling_reached"
    And the gateway reported the refusal "model_spend_ceiling_reached"
    And no request reached the vendor

  Scenario: The spend of several turns is added up against the ceiling
    Given organization "anthus" has spent 20.00 US dollars on models this month
    And organization "anthus" has spent 5.50 US dollars on models this month
    And the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    Then the gateway answers with status 403
    And the gateway error code is "model_spend_ceiling_reached"
    And no request reached the vendor

  Scenario: Another organization's spend does not count against this one
    Given organization "neighbor" has spent 400.00 US dollars on models this month
    And the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    Then the gateway answers with status 200
    And the vendor received exactly 1 request

  Scenario: A new calendar month starts the count again
    Given organization "anthus" has spent 25.00 US dollars on models this month
    And the clock reaches the first day of the next month
    And the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    Then the gateway answers with status 200
    And the vendor received exactly 1 request

  Scenario: Spend that cannot be read refuses the call rather than letting it through
    Given the organization's model spend cannot be read
    And the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    Then the gateway answers with status 503
    And the gateway error code is "model_spend_unavailable"
    And the gateway reported the refusal "model_spend_unavailable"
    And no request reached the vendor
