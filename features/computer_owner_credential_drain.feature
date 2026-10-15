Feature: The control plane drains a computer owner from the credentials it issued, and offers it nothing in the last stretch of its eight hours
  As an operator of an organization's computer
  I want the owner to be told to drain a fixed time before the credentials it holds end, and never later than seven hours and fifty minutes after it started
  So that an owner that cannot renew behaves exactly as before, an owner that renews can live for a working day, and no owner is ever running on credentials that are gone

  The control plane records when the credentials it issued to the owner end: the
  minimum of the AWS credentials and the supervisor token. It tells the owner to
  drain when those credentials end within ten minutes (the grace of the turn in
  hand, the final publish and a margin), when the owner has served for 28200
  seconds, or when the owner runs a protocol version below the minimum. An owner
  that never renews holds its first credentials for an hour, so it is told to
  drain at fifty minutes, exactly as it was when the lifetime was a fixed fifty
  minutes. In the last 900 seconds of the eight hour limit the control plane
  offers no turn, because the credential broker would refuse to issue
  credentials for it. The contract is docs/OWNER_CREDENTIAL_RENEWAL.md sections
  3, 4 and 6.4. The renewal route and the supervisor that uses it are told in
  computer_owner_credential_renewal.feature, which is still a draft.

  Background:
    Given an empty control plane
    And the organization is homed in the deployment account
    And tenant "anthus" user "ryan" has a bot named "Researcher"
    And a fake owner credential broker

  @server
  Scenario: The bootstrap records when the credentials it issued end
    Given a bootstrapped owner of the household computer
    Then the computer records that the owner's credentials end 3600 seconds after its bootstrap

  @server
  Scenario: The control plane drains an owner that does not renew when its credentials are ten minutes from the end
    Given a bootstrapped owner of the household computer
    When the clock has moved 2999 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 4
    Then the poll answered no drain
    When the clock has moved 3000 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 5
    Then the poll answered drain with reason "credentials" and no dispatch

  @server
  Scenario: The drain follows the credentials that were issued and not a fixed lifetime
    Given a bootstrapped owner of the household computer whose credentials were issued to end 1800 seconds after its bootstrap
    When the clock has moved 1199 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 4
    Then the poll answered no drain
    When the clock has moved 1200 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 5
    Then the poll answered drain with reason "credentials" and no dispatch

  @server
  Scenario: An owner whose credentials were renewed is not drained at fifty minutes and is drained at seven hours and fifty
    Given a bootstrapped owner of the household computer whose credentials were renewed until 28800 seconds after its bootstrap
    When the clock has moved 3000 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 4
    Then the poll answered no drain
    When the clock has moved 28199 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 40
    Then the poll answered no drain
    When the clock has moved 28200 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 41
    Then the poll answered drain with reason "lifetime" and no dispatch

  @server
  Scenario: No dispatch is offered in the last 900 seconds of the hard lifetime
    Given a bootstrapped owner of the household computer whose credentials were renewed until 28800 seconds after its bootstrap
    And a turn of bot "Researcher" parked on a workspace action
    When the clock has moved 27899 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 4
    Then the poll offered one dispatch
    When the clock has moved 27900 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 5
    Then the poll answered no dispatch and no drain
    And the broker was not asked for turn credentials after that
    When the clock has moved 27950 seconds past the owner's bootstrap
    And the owner polls in state "idle" with sequence 6
    Then the poll answered no dispatch and no drain
    And the control plane logged "owner_dispatch_withheld" once for the owner

  @server
  Scenario Outline: A stop for the drain is approved whatever the drain was for
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    And the control plane drains the owner because of <cause>
    When the owner asks to stop with reason "lifetime"
    Then the stop was approved

    Examples:
      | cause                                            |
      | credentials that would expire within 600 seconds |
      | the lifetime of 28200 seconds                    |
      | a protocol version below the minimum             |

  @server
  Scenario: A stop for credentials the owner could not renew is approved whatever is pending
    Given a bootstrapped owner of the household computer
    And a turn of bot "Researcher" parked on a workspace action
    When the owner asks to stop with reason "credentials"
    Then the stop was approved

  @server
  Scenario: An owner below the minimum protocol version is told to drain and is offered nothing
    Given a bootstrapped owner of the household computer that announced protocol version 2
    And a turn of bot "Researcher" parked on a workspace action
    When the owner polls in state "idle" with sequence 1
    Then the poll answered drain with reason "protocol_version" and no dispatch

  @server
  Scenario: An owner at the minimum protocol version, the one that renews its credentials, is not told to drain
    Given a bootstrapped owner of the household computer that announced protocol version 3
    When the owner polls in state "idle" with sequence 1
    Then the poll answered no drain

  @server
  Scenario: An owner far past its lifetime is reported
    Given a bootstrapped owner of the household computer whose credentials were issued to end 29000 seconds after its bootstrap
    When the clock has moved 28801 seconds past the owner's bootstrap
    And the owner polls in state "serving" with sequence 4
    Then the control plane logged "owner_overdue" for the owner with its age
