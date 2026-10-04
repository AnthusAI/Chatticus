Feature: A failed model call ends the turn honestly
  As a household member
  I want a turn whose model call cannot succeed to say so right away
  So that I am never left watching a bot that will not answer

  A model provider error is either permanent (retrying cannot help: the
  account is out of quota, the key is rejected, the request is invalid) or
  temporary (rate limited, provider unavailable). A permanent error fails the
  turn at once with a reason a person can act on, and the queued job is not
  retried. A temporary error leaves the turn active so the queue can retry it.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has a channel with a named bot "Assistant"

  Scenario Outline: A permanent provider error fails the turn at once with a readable reason
    Given the model provider answers every request with status <status> and error code "<code>"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    And user "ryan" of tenant "anthus" is watching that turn through server-sent events
    And bot "Assistant" runs one computerless worker turn against that provider
    Then the turn has failed with reason "<reason>"
    And user "ryan" receives a failed server-sent event with reason "<reason>"
    And the model provider was called once
    And no job for bot "Assistant" is left to retry

    Examples:
      | status | code                | reason                                                                                  |
      | 429    | insufficient_quota  | The model provider refused the request: the account is out of credits or over its quota. |
      | 401    | invalid_api_key     | The model provider rejected the API key.                                                 |
      | 400    | unsupported_value   | The model provider rejected the request as invalid.                                      |

  Scenario Outline: A temporary provider error leaves the turn for a retry
    Given the model provider answers every request with status <status> and error code "<code>"
    When user "ryan" of tenant "anthus" posts "hello" addressed to bot "Assistant" on the channel
    And bot "Assistant" runs one computerless worker turn against that provider
    Then the worker reports a temporary model provider failure
    And the turn is still active
    And a job for bot "Assistant" is still queued for a retry

    Examples:
      | status | code                |
      | 429    | rate_limit_exceeded |
      | 500    | server_error        |
      | 503    | overloaded          |

  Scenario: A worker without the current fence cannot fail the turn
    Given a worker owns an active turn
    When a worker reports the turn failed with a fence it does not hold
    Then the failure report is rejected as stale
    And the turn is still active
