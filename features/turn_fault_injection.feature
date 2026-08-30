Feature: Turn boundary fault injection
  As a household member
  I want interrupted turns to recover cleanly at every durable boundary
  So that crashes never duplicate work or leave two authoritative actors

  Background:
    Given a turn fault harness for tenant "anthus" user "ryan"

  Scenario Outline: Crash <window> <boundary> recovers to one answer
    Given the harness arms a crash <window> <boundary>
    When the harness drives the turn until the crash
    And the harness recovers and completes the turn
    Then provider calls equal 1
    And the channel has one human message and one bot answer
    And the turn status is completed
    And at most one worker is authoritative

    Examples:
      | window | boundary            |
      | before | message_commit      |
      | after  | message_commit      |
      | before | logical_enqueue     |
      | after  | logical_enqueue     |
      | before | worker_claim        |
      | after  | worker_claim        |
      | before | model_acceptance    |
      | after  | model_acceptance    |
      | before | progress_append     |
      | after  | progress_append     |
      | before | completion_append   |
      | after  | completion_append   |
      | before | acknowledgement     |
      | after  | acknowledgement     |
      | before | deadline_recovery   |
      | after  | deadline_recovery   |
