Feature: The credential broker issues owner credentials only for the owner a valid token names
  As the operator of an organization computer
  I want one small function to be the only principal that assumes the two owner roles and signs the owner tokens
  So that the starter holds no role, the Front Door cannot name an owner a token does not name, and a failure never leaks a secret

  The OwnerCredentialBroker is invoked by the Front Door. It verifies the
  authorization it is handed with the signing key before it does anything: the
  bootstrap token for a supervisor grant, the supervisor token for a supervisor
  renewal or a turn grant.
  It assumes ComputerSupervisorRole with two session tags, or
  ComputerOwnerScopedRole with five, for one hour and with no session policy,
  and signs the supervisor token or the model gateway token to expire when the
  credentials do, and never later than eight hours after the owner started,
  which it reads from the signed start time of the supervisor token. It refuses
  everything else. What the two roles allow is
  proved by supervisor_role_policy.feature and owner_role_policy.feature.

  Scenario: The broker issues supervisor credentials for the owner a bootstrap token names
    Given the broker holds the signing key
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the role "ComputerSupervisorRole" was assumed for 3600 seconds
    And the session tags are exactly "tenant" and "computer"
    And the broker's assume-role call carries no session policy
    And the answer holds a supervisor token for the audience "computer-owner" that names no turn
    And the credentials, the token and the token's expiry end at the same moment

  Scenario: The broker issues turn credentials with the five tags and a gateway token
    Given the broker holds the signing key
    When the broker is asked for turn credentials for bot "bot-1", channel "channel-1" and turn "turn-1" with a valid supervisor token
    Then the role "ComputerOwnerScopedRole" was assumed for 3600 seconds
    And the session tags are exactly "tenant", "bot", "channel", "computer" and "turn"
    And the broker's assume-role call carries no session policy
    And the answer holds a gateway token for the audience "model-gateway" bound to the turn, the bot and the owner id

  Scenario Outline: The broker refuses what it should not issue
    Given the broker holds the signing key
    When the broker is asked for <purpose> credentials and <fault>
    Then the broker answers not ok with the code "<code>"
    And STS was not asked to assume a role

    Examples:
      | purpose    | fault                                                          | code                   |
      | supervisor | the authorization is a supervisor token                        | invalid_authorization  |
      | supervisor | the authorization is expired                                   | invalid_authorization  |
      | supervisor | the authorization names another owner than the payload        | authorization_mismatch |
      | supervisor | the authorization names another generation than the payload    | authorization_mismatch |
      | turn       | the authorization is a bootstrap token                         | invalid_authorization  |
      | turn       | the authorization names another organization than the payload  | authorization_mismatch |
      | turn       | the bot id is "bot 1"                                          | unsafe_tag_value       |
      | turn       | the payload has no turn                                        | invalid_request        |
      | supervisor | the payload names a turn                                       | invalid_request        |
      | turn       | the payload version is 2                                       | invalid_request        |

  Scenario: The broker reports an STS failure by name only
    Given the broker holds the signing key
    And STS refuses the assume-role call with the error "AccessDenied"
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the broker answers not ok with the code "assume_role_failed"
    And the message is "AccessDenied" and holds no token, key or credential

  Scenario: The broker cannot sign without its key
    Given the broker cannot read the signing key
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the broker answers not ok with the code "signing_key_unavailable"
    And STS was not asked to assume a role

  Scenario: A supervisor token issued at bootstrap names the moment the owner started
    Given the broker holds the signing key
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the answer holds a supervisor token whose bootstrap time is the time of the broker's clock

  # Renewal. An owner lives up to eight hours from its bootstrap by asking again
  # for the credentials of the supervisor role. The supervisor token it holds is
  # the authorization, and the start time it signed at bootstrap is the only clock
  # the broker has: it reads no store, so it ends every credential at that start
  # plus the hard lifetime and refuses to issue in the last minimum session of it.

  Scenario: The broker renews supervisor credentials with the role and tags of the bootstrap
    Given the broker holds the signing key
    When the broker is asked for supervisor renewal credentials with a valid supervisor token
    Then the role "ComputerSupervisorRole" was assumed for 3600 seconds
    And the session tags are exactly "tenant" and "computer"
    And the broker's assume-role call carries no session policy
    And the session name is the session name of the bootstrap
    And the answer holds a supervisor token that keeps the bootstrap time of the token it was given
    And the credentials, the token and the token's expiry end at the same moment

  Scenario Outline: The broker refuses what it should not renew
    Given the broker holds the signing key
    When the broker is asked for supervisor renewal credentials and <fault>
    Then the broker answers not ok with the code "<code>"
    And STS was not asked to assume a role

    Examples:
      | fault                                                         | code                   |
      | the authorization is a bootstrap token                        | invalid_authorization  |
      | the authorization is a model gateway token                    | invalid_authorization  |
      | the authorization is an expired supervisor token              | invalid_authorization  |
      | the authorization names another owner than the payload        | authorization_mismatch |
      | the authorization names another computer than the payload     | authorization_mismatch |
      | the authorization is a supervisor token without a start time  | invalid_authorization  |
      | the owner was bootstrapped 27901 seconds ago                  | owner_lifetime_over    |
      | the owner was bootstrapped 30000 seconds ago                  | owner_lifetime_over    |
      | the payload names a turn                                      | invalid_request        |

  Scenario: No credential the broker issues outlives the hard lifetime
    Given the broker holds the signing key
    And the supervisor token names a bootstrap 26000 seconds ago
    When the broker is asked for supervisor renewal credentials with a valid supervisor token
    Then the role was assumed for 2800 seconds
    And the credentials, the token and the token's expiry end 28800 seconds after the bootstrap
    When the broker is asked for turn credentials with a valid supervisor token
    Then the role was assumed for 2800 seconds
    And the gateway token and the credentials end 28800 seconds after the bootstrap

  Scenario: The last session the broker grants is the shortest one STS allows
    Given the broker holds the signing key
    And the supervisor token names a bootstrap 27900 seconds ago
    When the broker is asked for supervisor renewal credentials with a valid supervisor token
    Then the role was assumed for 900 seconds
    And the credentials, the token and the token's expiry end 28800 seconds after the bootstrap

  Scenario: A turn is refused for a supervisor token without a start time
    Given the broker holds the signing key
    When the broker is asked for turn credentials with a supervisor token without a start time
    Then the broker answers not ok with the code "invalid_authorization"
    And STS was not asked to assume a role

  Scenario: A turn is refused in the last minimum session of the hard lifetime
    Given the broker holds the signing key
    And the supervisor token names a bootstrap 27901 seconds ago
    When the broker is asked for turn credentials with a valid supervisor token
    Then the broker answers not ok with the code "owner_lifetime_over"
    And STS was not asked to assume a role

  Scenario: A renewal reports an STS failure by name only
    Given the broker holds the signing key
    And STS refuses the assume-role call with the error "AccessDenied"
    When the broker is asked for supervisor renewal credentials with a valid supervisor token
    Then the broker answers not ok with the code "assume_role_failed"
    And the message is "AccessDenied" and holds no token, key or credential
