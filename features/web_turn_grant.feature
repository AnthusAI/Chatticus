Feature: Workspace UI to replace an active turn grant
  As an enabled organization member
  I want to replace the active turn grant from the product workspace
  So I do not need the members CLI or a kernel to authorize a task

  Scenario: A member submits a closed grant from the workspace
    Given the enabled workspace web SPA with an active turn for "ryan@example.com" in "Anthus Labs"
    When the web SPA replaces the active turn grant with:
      | field          | value                    |
      | tools          | browse, read_workspace   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace               |
      | egress_classes | approved_origin_fetch    |
    Then the web SPA shows turn grant confirmation for "browse, read_workspace"
    And the active turn grant is exactly that table
    And the turn journal records a grant replacement by the signed-in member

  Scenario: Replacing the grant from the workspace does not union with the conversation preset
    Given the enabled workspace web SPA with an active turn for "ryan@example.com" in "Anthus Labs"
    When the web SPA replaces the active turn grant with:
      | field          | value                    |
      | tools          | browse                   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace/docs          |
      | egress_classes | approved_origin_fetch    |
    Then the active turn grant is exactly that table
    And the active turn grant does not include tool "write_workspace"
    And the active turn grant does not include tool "read_workspace"

  Scenario: A workspace grant includes run_terminal only when explicitly chosen
    Given the enabled workspace web SPA with an active turn for "ryan@example.com" in "Anthus Labs"
    When the web SPA replaces the active turn grant with run_terminal checked and:
      | field          | value                    |
      | tools          | browse, read_workspace   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace               |
      | egress_classes | approved_origin_fetch    |
    Then the active turn grant is exactly that table
    And the active turn grant includes tool "run_terminal"

  Scenario: A browse-only workspace grant does not include run_terminal
    Given the enabled workspace web SPA with an active turn for "ryan@example.com" in "Anthus Labs"
    When the web SPA replaces the active turn grant with:
      | field          | value                    |
      | tools          | browse                   |
      | origins        | https://docs.example.com |
      | recipients     |                          |
      | file_scopes    | /workspace/docs          |
      | egress_classes | approved_origin_fetch    |
    Then the active turn grant does not include tool "run_terminal"

  Scenario: The grant panel is unavailable without an active turn
    Given the enabled workspace web SPA for "ryan@example.com" in "Anthus Labs"
    And the web SPA creates bot "Researcher"
    Then the web SPA does not show the turn grant form
    When the web SPA tries to replace the active turn grant with an empty tool list
    Then the web SPA did not call replace turn grant

  Scenario: A grant beyond standing shows an error and leaves the grant unchanged
    Given the enabled workspace web SPA with an active turn for "ryan@example.com" in "Anthus Labs"
    And the signed-in member has a grant standing ceiling of:
      | field       | value          |
      | tools       | read_workspace |
      | file_scopes | /workspace     |
    When the web SPA replaces the active turn grant with tools beyond that standing
    Then the web SPA shows a turn grant error
    And the active turn still carries the household conversation grant
    And the turn journal does not record a grant replacement

  Scenario: PUT /turns/{turn_id}/grant accepts an empty tools list as a full replace
    Given the enabled workspace web SPA with an active turn for "ryan@example.com" in "Anthus Labs"
    When PUT /turns/{turn_id}/grant is called with an empty tools list for the active turn
    Then PUT /turns/{turn_id}/grant responds with status 200
    And the active turn grant has no tools
