Feature: User routes act as the signed-in user
  As an organization member
  I want every user route to act only as me
  So that no other member can post as me, read my channels, or work on my tasks

  Background:
    Given an empty control plane
    And tenant "anthus" has the members "alice" and "bob"
    And user "alice" of tenant "anthus" has a direct channel with bot "Helper"

  Scenario: A member posts as themselves
    When member "alice" posts "hello" on the channel as human "alice"
    Then the identity binding response status is 200

  Scenario: A member cannot post as another member
    When member "bob" posts "hello" on the channel as human "alice"
    Then the identity binding response status is 403

  Scenario: A member cannot post as a bot on the user message route
    When member "alice" posts "hello" on the channel as bot "Helper"
    Then the identity binding response status is 403

  Scenario: A member who is not on the channel cannot post to it
    When member "bob" posts "hello" on the channel as human "bob"
    Then the identity binding response status is 403

  Scenario: A member who is not on the channel cannot read its messages
    When member "bob" lists the messages of the channel
    Then the identity binding response status is 403

  Scenario: A member who is not on the channel cannot read the channel
    When member "bob" reads the channel
    Then the identity binding response status is 403

  Scenario: A member cannot send a voice line as another member
    When member "bob" sends a voice line on the channel as user "alice"
    Then the identity binding response status is 403

  Scenario: A member cannot open a channel for another member
    When member "bob" opens a direct channel for user "alice" with bot "Helper"
    Then the identity binding response status is 403

  Scenario: A member cannot list another member's channels
    When member "bob" lists the channels of user "alice"
    Then the identity binding response status is 403

  Scenario: An organization owner can list a member's channels
    When the organization owner lists the channels of user "alice"
    Then the identity binding response status is 200

  Scenario: A member cannot create a task for another member
    When member "bob" creates a task for user "alice"
    Then the identity binding response status is 403

  Scenario: A member cannot list another member's tasks
    Given user "alice" of tenant "anthus" has a task from bot "Helper"
    When member "bob" lists the tasks of user "alice"
    Then the identity binding response status is 403

  Scenario: A member cannot read or change another member's task
    Given user "alice" of tenant "anthus" has a task from bot "Helper"
    When member "bob" reads the task of user "alice"
    Then the identity binding response status is 403
    When member "bob" closes the task of user "alice"
    Then the identity binding response status is 403

  Scenario: A member works on their own tasks
    Given user "alice" of tenant "anthus" has a task from bot "Helper"
    When member "alice" lists the tasks of user "alice"
    Then the identity binding response status is 200
    When member "alice" closes the task of user "alice"
    Then the identity binding response status is 200
