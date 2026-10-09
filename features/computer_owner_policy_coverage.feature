Feature: The owner session policy covers every request the computer owner makes
  As the operator of an organization computer
  I want the scoped credentials of a computer owner to allow exactly the requests a turn needs
  So that a live run never ends in a denial that only one run at a time could reveal

  The container owner runs with credentials narrowed by a session policy. These
  scenarios run the real owner against the real stores with a recording around
  the DynamoDB and S3 clients, then ask the policy that the control plane would
  hand to STS whether it allows each recorded request: its action, its table or
  bucket, and its partition key or object key. A request the policy would deny
  fails the scenario and is listed with its key. Each scenario covers one way a
  turn reaches the stores: finishing a parked turn, failing, recovering a turn
  from an owner that vanished, and taking in a steered message.

  Background:
    Given an empty control plane
    And an S3 snapshot bucket bound to the host worker
    And tenant "anthus" user "ryan" has computer "household-computer"
    And a worker registered as:
      | worker_id    | garage-mac-1       |
      | tenant_id    | anthus             |
      | cost_class   | local              |
      | capabilities | computer,browser   |
      | computer_id  | household-computer |
    And the computer owner has an empty workspace directory
    And the requests of the computer owners are recorded

  Scenario: An owner that finishes a parked turn on the computer's disk stays inside its policy
    Given worker "garage-mac-1" has published computer "household-computer" with workspace file "notes.md" containing "first draft"
    And the model is scripted to call "write_workspace" with:
      """
      {"path": "/workspace/notes.md", "content": "second draft"}
      """
    And the model is scripted to answer "Notes saved."
    When the member asks "save the notes"
    And a Lambda-style owner works the turn until it parks
    And the owner "owner-1" runs the parked turn on its computer disk
    Then the owner's turn ended "done"
    And the computer owners made a "dynamodb:Query" request on a key starting "MB#"
    And the computer owners made a "dynamodb:GetItem" request on a key starting "PI#"
    And the computer owners made a "s3:GetObject" request on a key starting "tenants/"
    And every request the computer owners made is allowed by the owner session policy

  Scenario: An owner whose turn fails stays inside its policy
    Given the model provider answers every request with status 401 and error code "invalid_api_key"
    When the member asks "say hello"
    And the owner "owner-1" runs the parked turn on its computer disk
    Then the owner's turn ended "failed"
    And every request the computer owners made is allowed by the owner session policy

  Scenario: An owner that recovers a turn from a vanished owner stays inside its policy
    Given the model is scripted to call "run_terminal" with:
      """
      {"command": "echo started >> runs.log", "cwd": "/workspace"}
      """
    And the model is scripted to answer "I could not confirm that the command finished."
    When the member asks "append a line to the run log"
    And the member allows the turn tools "run_terminal" under "/workspace"
    And a Lambda-style owner works the turn until it parks
    And computer owner "first" takes over the turn and is held after its tool ran
    And the clock moves past the turn lease
    And computer owner "second" takes over the turn
    And held computer owner "first" is released
    Then the takeover of "second" ended "done"
    And the takeover of "first" ended "lost"
    And every request the computer owners made is allowed by the owner session policy

  Scenario: An owner that answers the browser tool at once and checks the spend ceiling stays inside its policy
    Given the model is scripted to call "browse" with:
      """
      {"url": "https://household.example.com/browser"}
      """
    And the model is scripted to answer "I could not use the browser."
    When the member asks "open the household browser"
    And the organization sets a monthly AWS spend ceiling of "500.00" dollars
    And the member allows the turn tool "browse" to reach the origin "https://household.example.com"
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And every request the computer owners made is allowed by the owner session policy

  Scenario: An owner that takes in a steered message stays inside its policy
    Given the model is scripted to answer "Working in metric units."
    And the model is scripted to answer "Understood, metric units."
    When the member asks "research the top accounts"
    And the member sends "use metric units" in the same channel
    And computer owner "container" takes over the turn
    Then the takeover of "container" ended "done"
    And the computer owners made a "dynamodb:Query" request on a key starting "MB#"
    And every request the computer owners made is allowed by the owner session policy
