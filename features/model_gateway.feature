Feature: Model gateway for a container's Pi session
  As the operator of an organization computer
  I want a container to reach the model only through the control plane's gateway, with a token for one turn
  So that the container never holds the model vendor's key and a stolen token can only spend on its own running turn

  The container's Pi sends its OpenAI Responses requests to the gateway and
  authenticates with a short-lived signed token bound to an organization, a
  bot, a turn and the owner id the start generated. The owner passes that id
  as the worker id of its claim, so the turn's current attempt records it; a
  second owner that takes the turn over makes the first owner's token useless. The gateway checks the token and
  the turn, forwards the request with the real key, streams the answer back
  as the vendor produces it, and records the spend once from the final usage.

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a channel with a named bot "Helper"
    And bot "Helper" has an active turn owned by a container owner
    And the vendor answers "Good morning." using 120 input tokens and 30 output tokens

  Scenario: Pi's model collection pointed at an address sends its request there with the session token
    When a Pi model collection pointed at the vendor address with the token "session-token-1" asks for an answer
    Then Pi received the answer "Good morning."
    And the vendor saw the authorization "Bearer session-token-1"

  Scenario: Pi's model collection sends the invoke key the Front Door requires
    When a Pi model collection pointed at the vendor address with the token "session-token-1" and the invoke key "invoke-key-1" asks for an answer
    Then Pi received the answer "Good morning."
    And the vendor saw the invoke key header "invoke-key-1"

  Scenario: Pi's model collection sends no invoke key header when it was not given one
    When a Pi model collection pointed at the vendor address with the token "session-token-1" asks for an answer
    Then the vendor saw no invoke key header

  Scenario: Pi's model collection reaches the real vendor key only through the gateway
    Given the container holds a session token for its turn valid for 300 seconds
    When a Pi model collection pointed at the gateway with the container's token asks for an answer
    Then Pi received the answer "Good morning."
    And the vendor saw the real key and not the session token

  Scenario: A valid token forwards the request and returns the answer
    Given the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    Then the gateway answers with status 200
    And the container receives the answer text "Good morning."
    And the vendor received exactly 1 request
    And the vendor saw the real key and not the session token

  Scenario: The answer streams through as the vendor produces it
    Given the container holds a session token for its turn valid for 300 seconds
    And the vendor holds its answer back after the first text delta
    When the container asks the model gateway for an answer and reads only the start
    Then the start of the answer reaches the container while the vendor is still answering
    When the vendor lets the rest of the answer go
    Then the container receives the answer text "Good morning."

  Scenario: The spend is recorded once from the final usage
    Given the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    Then the vendor ledger holds 120 input tokens and 30 output tokens for the turn
    And the gateway recorded spend 1 time

  Scenario: A token that has expired is refused
    Given the container holds a session token for its turn valid for 300 seconds
    When 301 seconds pass
    And the container asks the model gateway for an answer
    Then the gateway answers with status 401
    And no request reached the vendor
    And the vendor ledger holds no spend for the turn

  Scenario: A request with no token is refused
    When the container asks the model gateway for an answer without a token
    Then the gateway answers with status 401
    And no request reached the vendor

  Scenario: A token with a changed claim is refused
    Given the container holds a session token for its turn valid for 300 seconds
    And the container changes the turn named in its token without re-signing
    When the container asks the model gateway for an answer
    Then the gateway answers with status 401
    And no request reached the vendor

  Scenario: A token signed with another key is refused
    Given the container holds a session token for its turn signed with another key
    When the container asks the model gateway for an answer
    Then the gateway answers with status 401
    And no request reached the vendor

  Scenario: A token for a turn that is not running is refused
    Given the container holds a session token for a turn that does not exist
    When the container asks the model gateway for an answer
    Then the gateway answers with status 403
    And no request reached the vendor

  Scenario: A token naming another owner of the turn is refused
    Given the container holds a session token for its turn bound to another owner
    When the container asks the model gateway for an answer
    Then the gateway answers with status 403
    And no request reached the vendor

  Scenario: A second owner taking the turn over makes the first owner's token useless
    Given the container holds a session token for its turn valid for 300 seconds
    And the container's lease runs out and the owner "second-owner" takes the turn over
    When the container asks the model gateway for an answer
    Then the gateway answers with status 403
    And no request reached the vendor
    And the vendor ledger holds no spend for the turn

  Scenario: The owner that took the turn over is served with its own token
    Given the container's lease runs out and the owner "second-owner" takes the turn over
    And the owner "second-owner" holds a session token for the turn valid for 300 seconds
    When the container asks the model gateway for an answer
    Then the gateway answers with status 200
    And the container receives the answer text "Good morning."

  Scenario: A token is refused while the turn is parked and no owner holds a claim
    Given the container holds a session token for its turn valid for 300 seconds
    And the container's turn is released without an owner
    When the container asks the model gateway for an answer
    Then the gateway answers with status 403
    And no request reached the vendor

  Scenario: A token for another bot's turn is refused
    Given tenant "anthus" user "ryan" has a bot named "Scout"
    And the container holds a session token for its turn naming the bot "Scout"
    When the container asks the model gateway for an answer
    Then the gateway answers with status 403
    And no request reached the vendor

  Scenario: A token for a finished turn is refused
    Given the container holds a session token for its turn valid for 300 seconds
    And the container's turn has completed
    When the container asks the model gateway for an answer
    Then the gateway answers with status 403
    And no request reached the vendor
    And the vendor ledger holds no spend for the turn

  Scenario: A token cannot be used to reach another organization's turn
    Given the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway of organization "intruder" for an answer
    Then the gateway answers with status 403
    And no request reached the vendor

  Scenario: A token minted for another organization cannot name this organization's turn
    Given the container holds a session token for organization "intruder" naming its turn
    When the container asks the model gateway of organization "intruder" for an answer
    Then the gateway answers with status 403
    And no request reached the vendor

  Scenario: The real key never appears in a response, a header or a log
    Given the container holds a session token for its turn valid for 300 seconds
    When the container asks the model gateway for an answer
    And the vendor refuses the next request with its own error text that echoes the key
    And the container asks the model gateway for an answer
    And the container asks the model gateway for an answer without a token
    Then the real key appears in no response body, response header or log event of the gateway

  Scenario: A vendor failure is a clear error and records no spend
    Given the container holds a session token for its turn valid for 300 seconds
    And the vendor refuses the next request with its own error text that echoes the key
    When the container asks the model gateway for an answer
    Then the gateway answers with status 502
    And the error says the model provider request failed
    And the vendor ledger holds no spend for the turn
