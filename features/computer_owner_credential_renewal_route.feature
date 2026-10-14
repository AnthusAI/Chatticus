Feature: The control plane renews the credentials of the owner it still recognizes, and refuses the moment the owner is not the owner any more
  As an operator of an organization's computer
  I want a renewal route that hands a live owner the next set of credentials, its own or those of the turn it serves, and refuses every other caller
  So that one owner can serve a working day, a stolen token buys at most the owner's own life, and a stopped or replaced owner never receives fresh credentials for a disk a newer owner holds

  An owner asks for new credentials at POST /host/owner/credentials with its
  supervisor token. The control plane checks the computer record before it asks
  the credential broker, because the broker reads no store: the owner must be the
  live owner of the current generation, no stop may be approved, the owner must
  not be draining and the last 900 seconds of its eight hours must not have
  begun (the turn kind is renewed while the owner drains, so the turn in hand
  can finish), a turn must be the one this owner serves, and the same kind may
  be renewed once a minute. A broker that cannot serve changes nothing. A grant
  is recorded in one conditional write, so a renewal that loses the race with an
  approved stop, or with another renewal of the same kind, is discarded unseen.
  A renewal is not work: it never moves the idle clock. The contract is
  docs/OWNER_CREDENTIAL_RENEWAL.md sections 3, 6.1 to 6.3 and 17 (part A2). The
  broker's side, the supervisor that asks, and the child that reads are told in
  computer_owner_credential_renewal.feature, which is still a draft.

  Background:
    Given an empty control plane
    And the organization is homed in the deployment account
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And tenant "anthus" user "ryan" has a bot named "Analyst"
    And a fake owner credential broker

  @server
  Scenario: The owner renews its supervisor credentials and keeps its generation
    Given a bootstrapped owner of the household computer
    When the clock has moved 2400 seconds past the owner's bootstrap
    And the owner asks for new supervisor credentials
    Then the answer is 200
    And the answer holds a supervisor token valid for 3600 seconds, a new set of supervisor credentials and no turn
    And the supervisor token keeps the owner's bootstrap time and names the same organization, computer, owner and generation
    And the broker was asked for supervisor renewal credentials with the owner's current supervisor token as the authorization
    And the computer records the new expiry of the owner's credentials
    And the computer still records the same owner and generation 1
    And the previous supervisor token still opens the poll route until it expires
    And the control plane logged "owner_credentials_refresh_ok" for the owner with "kind=supervisor" and no token or credential

  @server
  Scenario Outline: A renewal that is not good is refused
    Given a bootstrapped owner of the household computer
    When the owner asks for new supervisor credentials with a token that is <fault>
    Then the answer is <status> with the code "<code>"
    And the broker was not asked for renewal credentials

    Examples:
      | fault                                        | status | code                |
      | expired                                      | 401    | invalid_credential  |
      | signed with another key                      | 401    | invalid_credential  |
      | a bootstrap token                            | 401    | invalid_credential  |
      | a model gateway token                        | 401    | invalid_credential  |
      | for another organization                     | 403    | wrong_organization  |
      | for generation 2 while generation 1 runs     | 403    | stale_generation    |
      | an owner that a newer owner replaced         | 403    | not_current_owner   |

  @server
  Scenario: A renewal that names another owner than its token is refused
    Given a bootstrapped owner of the household computer
    When the owner asks for new supervisor credentials naming another owner id
    Then the answer is 403 with the code "credential_mismatch"
    And the broker was not asked for renewal credentials

  @server
  Scenario: A renewal is refused after the computer stopped
    Given a bootstrapped owner of the household computer
    And the owner reports the computer stopped for generation 1
    When the owner asks for new supervisor credentials
    Then the answer is 403 with the code "not_current_owner"
    And the broker was not asked for renewal credentials

  @server
  Scenario: The credentials route is not part of the stopped report replay
    Given a bootstrapped owner of the household computer
    And the owner reports the computer stopped for generation 1
    When the owner reports the computer stopped for generation 1 again
    Then the answer is 200
    When the owner asks for new supervisor credentials
    Then the answer is 403 with the code "not_current_owner"

  @server
  Scenario: A renewal is refused once a stop was approved
    Given a bootstrapped owner of the household computer
    And the owner asks to stop with reason "unhealthy"
    And the stop was approved
    When the owner asks for new supervisor credentials
    Then the answer is 409 with the code "owner_stopping"
    And the broker was not asked for renewal credentials
    And the control plane logged "owner_credentials_refresh_refused" for the owner with "code=owner_stopping" and no token or credential

  @server
  Scenario Outline: A renewal is refused once the control plane drains the owner
    Given a bootstrapped owner of the household computer
    And the control plane drains the owner because of <cause>
    When the owner asks for new supervisor credentials
    Then the answer is 409 with the code "owner_draining"
    And the broker was not asked for renewal credentials

    Examples:
      | cause                                                 |
      | credentials that would expire within 600 seconds      |
      | the lifetime of 28200 seconds                         |
      | a protocol version below the minimum                  |

  @server
  Scenario: No renewal is granted in the last 900 seconds of the hard lifetime
    Given a bootstrapped owner of the household computer whose credentials were renewed until 28800 seconds after its bootstrap
    When the clock has moved 27900 seconds past the owner's bootstrap
    And the owner asks for new supervisor credentials
    Then the answer is 409 with the code "owner_draining"
    And the broker was not asked for renewal credentials

  @server
  Scenario: Renewals are limited to one a minute for each kind
    Given a bootstrapped owner of the household computer
    When the owner asks for new supervisor credentials
    And the owner asks for new supervisor credentials again 30 seconds later
    Then the second answer is 429 with the code "renewal_too_soon"
    And the broker was asked for renewal credentials once
    When the clock moves 31 seconds
    And the owner asks for new supervisor credentials
    Then the answer is 200

  @server
  Scenario: Two renewals asked at the same moment grant one
    Given a bootstrapped owner of the household computer
    When the clock has moved 2400 seconds past the owner's bootstrap
    And the owner asks for new supervisor credentials twice at the same moment
    Then exactly one of the two answers is 200 and the other is 429 with the code "renewal_too_soon"
    And the computer records the new expiry of the owner's credentials

  @server
  Scenario: A renewal the broker cannot serve changes nothing and may be asked again at once
    Given a bootstrapped owner of the household computer
    And the broker is unavailable
    When the owner asks for new supervisor credentials
    Then the answer is 503 with the code "credentials_unavailable"
    And the computer records that the owner's credentials end 3600 seconds after its bootstrap
    When the broker is available again
    And the owner asks for new supervisor credentials
    Then the answer is 200

  @server
  Scenario: A renewal the broker refuses because the lifetime is over is final
    Given a bootstrapped owner of the household computer
    And the broker refuses the next call because the owner's lifetime is over
    When the owner asks for new supervisor credentials
    Then the answer is 409 with the code "owner_draining"
    And the computer records that the owner's credentials end 3600 seconds after its bootstrap

  @server
  Scenario: A renewal that lost the race with an approved stop is discarded unseen
    Given a bootstrapped owner of the household computer
    And the broker holds its answer until released
    When the owner asks for new supervisor credentials
    And the owner asks to stop with reason "unhealthy" and the stop is approved
    And the broker releases its answer
    Then the renewal answer is 409 with the code "owner_stopping"
    And the computer records that the owner's credentials end 3600 seconds after its bootstrap

  @server
  Scenario: The owner renews the credentials of the turn it serves
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" was dispatched to the owner and claimed
    When the clock has moved 2400 seconds past the dispatch
    And the owner asks for new credentials for the dispatched turn
    Then the answer is 200
    And the answer holds a model gateway token bound to the turn, the bot and the owner id
    And the answer holds credentials for a session tagged with the tenant, the bot, the channel, the computer and the turn
    And the broker was asked for turn credentials with the owner's supervisor token as the authorization
    And the control plane logged "owner_credentials_refresh_ok" for the owner with "kind=turn" and no token or credential

  @server
  Scenario Outline: Turn credentials are refused for a turn the owner is not serving
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" was dispatched to the owner and claimed
    When the owner asks for new credentials for <request>
    Then the answer is 409 with the code "turn_not_served"
    And the broker was not asked for turn credentials

    Examples:
      | request                                             |
      | a dispatch id that was never offered                |
      | a turn id other than the dispatched turn            |
      | the dispatched turn after it ended                  |
      | the dispatched turn after another owner claimed it  |

  @server
  Scenario: Turn credentials are renewed while the owner drains but not after a stop is approved
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" was dispatched to the owner and claimed
    And the control plane drains the owner because of credentials that would expire within 600 seconds
    When the owner asks for new credentials for the dispatched turn
    Then the answer is 200
    When the owner asks to stop with reason "lifetime" and the stop is approved
    And the clock moves 61 seconds
    And the owner asks for new credentials for the dispatched turn
    Then the answer is 409 with the code "owner_stopping"

  @server
  Scenario: Turn credentials are refused in the last 900 seconds of the hard lifetime
    Given a bootstrapped owner of the household computer whose credentials were renewed until 28800 seconds after its bootstrap
    And a turn of bot "Researcher" was dispatched to the owner and claimed
    When the clock has moved 27900 seconds past the owner's bootstrap
    And the owner asks for new credentials for the dispatched turn
    Then the answer is 409 with the code "owner_draining"
    And the broker was not asked for turn credentials

  @server
  Scenario: Turn credentials and supervisor credentials are limited separately
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" was dispatched to the owner and claimed
    When the owner asks for new supervisor credentials
    And the owner asks for new credentials for the dispatched turn
    Then both answers are 200
    When the owner asks for new credentials for the dispatched turn again 30 seconds later
    Then the answer is 429 with the code "renewal_too_soon"

  @server
  Scenario: A new dispatch starts the turn credential limit over
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" was dispatched to the owner and claimed
    And the owner asked for new credentials for the dispatched turn
    When a turn of bot "Analyst" is dispatched to the owner and claimed 10 seconds later
    And the owner asks for new credentials for that dispatch
    Then the answer is 200

  @server
  Scenario: The credentials route cannot be opened with the invoke key alone
    Given a bootstrapped owner of the household computer
    When a caller with the invoke key and no token calls "POST /owner/credentials"
    Then the answer is 403 with the code "not_current_owner"
    And the broker was not asked for renewal credentials

  @server
  Scenario: A renewal does not count as work
    Given a bootstrapped owner of the household computer
    And the owner polls in state "idle"
    And the computer records when the owner became idle
    When the clock moves 120 seconds
    And the owner asks for new supervisor credentials
    Then the answer is 200
    And the computer still records the same idle start
    And no dispatch, stop approval or file operation was recorded
