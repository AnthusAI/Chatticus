Feature: The model gateway reports why it refused a request and how the model call went
  As the operator of an organization computer
  I want the gateway to log every refusal with its reason and every upstream failure with its status
  So that a stalled real-work turn can be traced to the request that was turned away, without any secret in the log

  The gateway names the reason of a refusal. It names the tenant, the turn and
  the owner only when the token's signature verified, because the claims of
  a token that did not verify are the caller's words. It never writes the
  token, a header value, a request or response body, or the vendor key. The
  owner side writes one model_call line for each request, with the status the
  gateway answered and how long it took.

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a channel with a named bot "Helper"
    And bot "Helper" has an active turn owned by a container owner
    And the vendor answers "Good morning." using 120 input tokens and 30 output tokens

  Scenario: A request with no token is refused for the missing header and names no turn
    When the container asks the model gateway for an answer without a token
    Then the gateway logged a refusal because "missing_header"
    And that refusal names no tenant, no turn and no owner

  Scenario: A token that has expired is refused for expiry
    Given the container holds a session token for its turn valid for 300 seconds
    When 301 seconds pass
    And the container asks the model gateway for an answer
    Then the gateway logged a refusal because "expired"
    And that refusal names no tenant, no turn and no owner

  Scenario: A token with a changed claim is refused as tampered and the changed claim is not logged
    Given the container holds a session token for its turn valid for 300 seconds
    And the container changes the turn named in its token without re-signing
    When the container asks the model gateway for an answer
    Then the gateway logged a refusal because "tampered"
    And that refusal names no tenant, no turn and no owner
    And no gateway log line contains "another-turn"

  Scenario: A token signed with another key is refused as tampered
    Given the container holds a session token for its turn signed with another key
    When the container asks the model gateway for an answer
    Then the gateway logged a refusal because "tampered"

  Scenario: A token naming another owner is refused for the wrong owner and names the verified ids
    Given the container holds a session token for its turn bound to another owner
    When the container asks the model gateway for an answer
    Then the gateway logged a refusal because "wrong_owner"
    And that refusal names the tenant and the turn of the container

  Scenario: A token for a turn that does not exist is refused for the wrong turn
    Given the container holds a session token for a turn that does not exist
    When the container asks the model gateway for an answer
    Then the gateway logged a refusal because "wrong_turn"

  Scenario: A token for a finished turn is refused for the finished turn
    Given the container holds a session token for its turn valid for 300 seconds
    And the container's turn has completed
    When the container asks the model gateway for an answer
    Then the gateway logged a refusal because "finished_turn"
    And that refusal names the tenant and the turn of the container

  Scenario: A token for another organization is refused for the organization
    Given the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway of organization "intruder" for an answer
    Then the gateway logged a refusal because "organization_mismatch"

  Scenario: A vendor failure is logged with the vendor's status and no vendor text
    Given the container holds a session token for its turn valid for 300 seconds
    And the vendor refuses the next request with its own error text that echoes the key
    When the container asks the model gateway for an answer
    Then the gateway logged an upstream failure with a status
    And no gateway log line contains the vendor key
    And no gateway log line contains the container's token

  @owner-log
  Scenario: The owner writes one model_call line for a request the gateway served
    Given the container holds a session token for its turn valid for 300 seconds
    When a Pi model collection pointed at the gateway with the container's token asks for an answer and logs as its owner
    Then Pi received the answer "Good morning."
    And the owner log of "container-owner" has a "model_call" line with "status" "200"
    And the owner log line "model_call" of "container-owner" has a "duration_ms" number
    And the owner log of "container-owner" has exactly 1 "model_call" line
    And the owner log of "container-owner" does not contain the container's token

  @owner-log
  Scenario: The owner writes the gateway's refusal status when its token is refused
    Given the container holds a session token for its turn bound to another owner
    When a Pi model collection pointed at the gateway with the container's token asks for an answer and logs as its owner
    Then the owner log of "container-owner" has a "model_call" line with "status" "403"
