Feature: The owner supervisor renews its credentials in place, swaps them in one step, and stops before they expire
  As an operator of an organization's computer
  I want the supervisor to ask for its next credentials twenty minutes before the ones it holds expire, without pausing its polls
  So that one supervisor can serve a working day, and one whose credentials cannot be renewed leaves in good order before they end

  The supervisor holds AWS credentials for the computer's snapshot prefix and a
  supervisor token; each lasts at most one hour. A renewal is a second activity
  next to the poll, like the overlay clear: it never delays a poll or a file
  request. The answer is swapped in one synchronous step, so no request mixes the
  old token with the new credentials, and the storage client is built once with a
  provider that returns whichever credentials the supervisor holds when a request
  begins, so a publish in flight finishes with the credentials it began with. A
  renewal is not work: it does not start the idle clock over, and a supervisor
  that is stopping renews nothing.

  When renewals keep failing, the supervisor drains itself ten minutes before its
  credentials end, stops with the reason credentials, which the control plane
  always approves, and, if the stop is still running thirty seconds before the
  credentials end, kills the child and exits with code 9. The supervisor renews
  the credentials of the turn it serves on the same schedule and keeps them in
  memory only, where the socket server reads them for the child.

  The contract is docs/OWNER_CREDENTIAL_RENEWAL.md. The scenarios of the draft
  computer_owner_credential_renewal.feature that this file does not hold belong to
  other parts of Phase 2b.

  An idle supervisor stops after fifteen minutes of no work when the control
  plane approves; the scenarios that run for longer than that have the control
  plane veto the idle stop, as it does while work is pending, so that the
  supervisor lives to the moment a renewal is due.

  Background:
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane vetoes every idle stop with "work_pending"

  Scenario: The supervisor announces the protocol version that renews credentials
    When the supervisor starts
    Then the control plane saw a bootstrap and polls that announce protocol version 3

  Scenario: The supervisor renews its credentials twenty minutes before they expire
    Given the control plane issues credentials that last 3600 seconds
    When the supervisor starts
    And 2399 seconds go by
    Then the supervisor asked for new supervisor credentials 0 times
    When 1 seconds go by
    Then the supervisor asked for new supervisor credentials once
    And its next request carried the new supervisor token
    And the disk was opened once and its storage requests after that carry the new credentials

  Scenario: Credentials shorter than the margin are renewed every minute and used past their first end
    Given the control plane issues credentials that last 900 seconds
    When the supervisor starts
    And 1000 seconds go by
    Then the supervisor asked for new supervisor credentials 16 times, never less than 60 seconds apart
    And the supervisor is still running
    And the disk was opened once and its storage requests after that carry the new credentials

  Scenario: The supervisor keeps polling while a renewal is in flight
    Given the control plane answers a renewal after 9 seconds
    When the supervisor starts
    And 2410 seconds go by
    Then the supervisor polled at least every 5 seconds during the renewal
    And it did not fence itself

  Scenario Outline: A renewal that fails is repeated with growing pauses until it succeeds
    Given the control plane answers the first 4 renewals with <failure>
    When the supervisor starts
    And 2400 seconds go by
    And 200 seconds go by
    Then the supervisor asked for new supervisor credentials 5 times, 15, 30, 60 and 60 seconds apart
    And the fifth renewal succeeded and the supervisor holds the new credentials
    And its log holds "owner_credentials_refresh_failed" 4 times and "owner_credentials_refreshed" once

    Examples:
      | failure                       |
      | 503 "credentials_unavailable" |
      | 429 "renewal_too_soon"        |
      | 422 "invalid_request"         |
      | a network error               |
      | a body that does not parse    |

  Scenario Outline: A renewal answer that does not fit what was asked is a failure and swaps nothing
    Given the control plane answers the first renewal with <answer>
    When the supervisor starts
    And 2401 seconds go by
    Then its log holds "owner_credentials_refresh_failed" 1 times and "owner_credentials_refreshed" 0 times
    And the supervisor holds its first credentials and its first token

    Examples:
      | answer                                        |
      | credentials for a turn instead                |
      | credentials that end before the ones it holds |

  Scenario Outline: A renewal the control plane refuses for good is not repeated
    Given the control plane answers every renewal with 409 "<code>"
    When the supervisor starts
    And 2500 seconds go by
    Then the supervisor asked for new supervisor credentials once
    And its log holds "owner_credentials_refresh_refused" 1 times and "owner_credentials_refreshed" 0 times
    And the supervisor goes on polling and serving with the credentials it holds

    Examples:
      | code           |
      | owner_draining |
      | owner_stopping |

  Scenario Outline: A renewal that says the owner is not the owner ends it
    Given the control plane answers the renewal with <status> "<code>"
    When the supervisor starts
    And 2401 seconds go by
    Then the supervisor stopped without publishing and exited with code 5
    And its log holds "owner_stopping" with the reason "superseded"

    Examples:
      | status | code               |
      | 401    | invalid_credential |
      | 403    | stale_generation   |
      | 403    | not_current_owner  |

  Scenario: An owner whose renewals keep failing drains ten minutes before its credentials expire and stops before they do
    Given the control plane answers every renewal with 503 "credentials_unavailable"
    And the disk takes 2 seconds to publish
    And a child is serving a turn that never ends on its own
    When the supervisor starts
    And 2999 seconds go by
    Then the supervisor is still running
    When 1 seconds go by
    Then the supervisor reported state "draining"
    And its log holds "owner_credentials_expiring" and "owner_draining"
    When the workspace has changed
    And 299 seconds go by
    Then the supervisor has not asked to stop
    When 6 seconds go by
    Then the child was ended and the supervisor asked to stop with reason "credentials"
    And the disk was published and the computer reported stopped for generation 1
    And the supervisor exited with code 0 before 3420 seconds after its bootstrap

  Scenario: A drain the control plane ordered first is stopped for the lifetime
    Given the control plane answers every renewal with 503 "credentials_unavailable"
    When the supervisor starts
    And the control plane answers a poll with drain and reason "credentials"
    Then the supervisor asked to stop with reason "lifetime" once
    And the supervisor asked to stop with reason "credentials" 0 times

  Scenario: An owner that cannot finish its stop before the credentials end exits at the hard deadline
    Given the control plane answers every renewal with 503 "credentials_unavailable"
    And the disk never finishes publishing
    When the supervisor starts
    And 2990 seconds go by
    And the workspace has changed
    And 579 seconds go by
    Then the supervisor is still running
    When 1 seconds go by
    Then the supervisor exited with code 9
    And its log holds "owner_stopping" with the reason "credentials_expired"
    And the disk was never published and no stopped report was made

  Scenario: A publish in flight when the credentials are swapped finishes and the next request uses the new ones
    Given the control plane issues credentials that last 3620 seconds
    And the disk takes 60 seconds to publish in requests of 15 seconds and records the credentials of each storage request
    When the supervisor starts
    And 2399 seconds go by
    And the workspace has changed
    And 26 seconds go by
    Then the supervisor asked for new supervisor credentials once, at 2420 seconds
    When 40 seconds go by
    Then the publish finished without an error
    And the storage requests that began before the renewal carry the first credentials
    And the storage requests that began after it carry the renewed credentials
    And a request began before the renewal and ended after it

  Scenario: The token and the credentials are swapped in one step
    Given the control plane issues credentials that last 3600 seconds
    When the supervisor starts
    And the supervisor's token and storage credentials are sampled after every renewal answer
    And 2401 seconds go by
    Then every sample held the old token with the old credentials or the new token with the new credentials
    And no request the control plane saw carried the new supervisor token while the storage client still used the old credentials
    And no request carried the old supervisor token after the first one that carried the new

  Scenario: A renewal does not start the supervisor's idle clock over
    Given the control plane issues credentials that last 1260 seconds
    And the control plane approves an idle stop
    When the supervisor starts
    And 901 seconds go by
    Then the supervisor asked for new supervisor credentials at least 14 times, never less than 60 seconds apart
    And the supervisor asked to stop with reason "idle"

  Scenario: The supervisor renews nothing once it is stopping
    Given the disk takes 20 seconds to publish
    When the supervisor starts
    And 2395 seconds go by
    And the workspace has changed
    And the supervisor receives SIGTERM
    And 10 seconds go by
    Then the supervisor is still running
    And the supervisor asked for new supervisor credentials 0 times
    When 20 seconds go by
    Then the supervisor asked for new supervisor credentials 0 times

  Scenario: A renewal in flight when the supervisor starts stopping is abandoned
    Given the control plane answers a renewal after 9 seconds
    And the disk takes 20 seconds to publish
    When the supervisor starts
    And 2395 seconds go by
    And the workspace has changed
    And 7 seconds go by
    And the supervisor receives SIGTERM
    And 10 seconds go by
    Then the supervisor is still running
    And the supervisor asked for new supervisor credentials once
    And its log holds "owner_credentials_refreshed" 0 times
    And the supervisor holds its first credentials and its first token

  Scenario: A live file request is answered while a renewal is in flight
    Given the control plane answers a renewal after 9 seconds
    And the control plane delivers a read request for "/workspace/notes.txt" in the poll at 2402 seconds
    When the supervisor starts
    And 2410 seconds go by
    Then the supervisor posted the answer to the read request within 2 seconds of receiving it

  Scenario: The supervisor renews the credentials of the turn it serves and keeps them in memory
    When the supervisor starts
    And the control plane dispatches the turn
    And 2401 seconds go by
    Then the supervisor asked for new credentials for the dispatched turn once
    And the child's environment holds the socket path and no AWS access key, secret key, session token or gateway token
    And the turn credential source answers with the renewed credentials for the dispatch and with nothing for another dispatch
    When the child exits with code 0
    Then the supervisor holds no credentials for any turn

  Scenario: A turn credential renewal that fails is repeated until it succeeds or the child ends
    Given the control plane answers the first 3 turn credential renewals with 503 "credentials_unavailable"
    When the supervisor starts
    And the control plane dispatches the turn
    And 2510 seconds go by
    Then the supervisor asked for new credentials for the dispatched turn 4 times
    And the turn credential source answers with the renewed credentials for the dispatch and with nothing for another dispatch

  Scenario: A turn credential renewal the control plane says is not served drops the lease
    Given the control plane answers every turn credential renewal with 409 "turn_not_served"
    When the supervisor starts
    And the control plane dispatches the turn
    And 2500 seconds go by
    Then the supervisor asked for new credentials for the dispatched turn once
    And its log holds "owner_credentials_refresh_refused" 1 times and "owner_credentials_refreshed" once
    And the supervisor holds no credentials for any turn

  Scenario: A draining owner renews the credentials of the turn it is finishing but not its own
    When the supervisor starts
    And the control plane dispatches the turn
    And 2300 seconds go by
    And the control plane answers a poll with drain and reason "lifetime"
    And 200 seconds go by
    Then the supervisor asked for new credentials for the dispatched turn once
    And the supervisor asked for new supervisor credentials 0 times

  Scenario: A turn credential renewal in flight when the child exits is abandoned
    Given the control plane answers a renewal after 9 seconds
    When the supervisor starts
    And the control plane dispatches the turn
    And 2401 seconds go by
    And the child exits with code 0
    And 20 seconds go by
    Then the supervisor holds no credentials for any turn
    And its log holds "owner_credentials_refreshed" for the kind "turn" 0 times

  Scenario: The supervisor logs about credentials carry no token, key or credential
    When the supervisor starts
    And the control plane dispatches the turn
    And 2401 seconds go by
    Then no log line holds the supervisor token, either set of credentials or a gateway token
    And its log holds "owner_credentials_refreshed" 2 times
