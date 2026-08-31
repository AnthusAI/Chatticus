Feature: Household task list in the web UI
  As a household member
  I want to see my tasks in the chattic.us web UI
  So that I can track open work over the same-origin API

  Scenario: The web UI loads the household task list from the same-origin API
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Assistant"
    When tenant "anthus" posts the task tool create action for bot "Assistant" with title "Pay the electric bill"
    And the web UI requests the task list for tenant "anthus" user "ryan"
    Then the web UI task list shows:
      | Pay the electric bill |

  Scenario: The web UI shows an empty state when there are no tasks
    Given an empty control plane
    When the web UI requests the task list for tenant "anthus" user "ryan"
    Then the web UI task list is empty

  Scenario: The web UI loads task details for a stored task
    Given an empty control plane
    And tenant "anthus" user "ryan" has a bot named "Assistant"
    When tenant "anthus" posts the task tool create action for bot "Assistant" with title "Pay the electric bill"
    And the web UI requests task details for the stored task as tenant "anthus"
    Then the web UI task detail shows title "Pay the electric bill"
    And the web UI task detail shows status "open"

  Scenario: The web UI handles a missing task gracefully
    Given an empty control plane
    When the web UI requests task "missing-task-id" as tenant "anthus"
    Then the web UI task detail request fails with not found
