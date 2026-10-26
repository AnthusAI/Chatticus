Feature: A deployed environment builds external channels only where it is configured and switched on
  As the operator of a Chatticus environment
  I want external channels to exist only where the deployment is set up for them, and to do anything only for the
  organizations I switched on
  So that deploying the capability changes nothing for any other organization, and nothing reaches the event bus unless a
  reply is really owed to an outside address

  The deployed front door and turn executor build their channel parts from environment variables. External channels
  exist in a deployment exactly where the mail domain is set. Even then the environment kill switch is engaged unless the
  deployment releases it, and each organization must be switched on by the operator. The plus-tag secret is read from an
  SSM SecureString by its exact name. When a reply is owed to an external transport, the executor records the delivery and
  publishes one event with ids only on the event bus; an organization that is not switched on records and publishes
  nothing. The contract is docs/EXTERNAL_CHANNELS.md.

  Background:
    Given an empty control plane
    And the deployment's parameter store holds the correlator secret under "/chatticus/test/channels/correlator-secret"
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Other House" has the owner "olive@example.org"
    And the organization "Anthus Labs" has the bot "Researcher"
    And the organization "Other House" has the bot "Assistant"

  Scenario: Where the deployment sets no mail domain external channels do not exist
    When the deployment composes external channels
    Then external channels do not exist in this deployment
    When "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the channel request is answered as not found

  Scenario: A deployment that does not release the kill switch stays closed to every organization
    Given the deployment sets the channel environment:
      | CHATTICUS_CHANNELS_MAIL_DOMAIN                       | mail.develop.example.test                |
      | CHATTICUS_CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME  | /chatticus/test/channels/correlator-secret |
      | CHATTICUS_CHANNELS_EVENT_BUS_NAME                    | default                                  |
      | CHATTICUS_CHANNELS_CONFIGURATION_SET_NAME            | chatticus-test-outbound                  |
      | CHATTICUS_CHANNELS_WEB_APP_BASE_URL                  | https://hey.example.test                 |
    When the deployment composes external channels
    And the operator switches external channels on for the organization "Anthus Labs"
    And "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the channel request is answered as not found

  Scenario: Releasing the kill switch changes nothing for an organization that is not switched on
    Given the deployment releases the kill switch
    And the Messaging table is counted
    When the deployment composes external channels
    And "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the channel request is answered as not found
    When "olive@example.org" chooses the mail handle "other" for "Other House"
    Then the channel request is answered as not found
    And the Messaging table holds the same items as when it was counted
    And the event bus received 0 events

  Scenario: Switching on one organization opens external channels for that organization only
    Given the deployment releases the kill switch
    When the deployment composes external channels
    And the operator switches external channels on for the organization "Anthus Labs"
    And "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the channel request is accepted
    When "ryan@example.com" creates an email binding for the bot "Researcher" in "Anthus Labs"
    Then the channel request is accepted
    And the binding address is "researcher@anthus.mail.develop.example.test"
    When "olive@example.org" chooses the mail handle "other" for "Other House"
    Then the channel request is answered as not found

  Scenario: A reply to an email is announced on the event bus with ids only
    Given the deployment releases the kill switch
    And the deployment composes external channels
    And the operator switches external channels on for the organization "Anthus Labs"
    And "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And "ryan@example.com" has created an email binding for the bot "Researcher" in "Anthus Labs"
    And the email sender "sam.sender@example.test" is linked to "sam@example.com" in "Anthus Labs"
    And the model will answer "The research is done."
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    Then 1 delivery was recorded
    And the event bus received 1 event
    And the bus event is a "channel.message.created" from "chatticus.channels" on the bus "default"
    And the bus event carries only the tenant, message and binding ids
    And the bus event does not contain the answer text or the sender

  Scenario: A reply owed after the organization was switched off is neither recorded nor announced
    Given the deployment releases the kill switch
    And the deployment composes external channels
    And the operator switches external channels on for the organization "Anthus Labs"
    And "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And "ryan@example.com" has created an email binding for the bot "Researcher" in "Anthus Labs"
    And the email sender "sam.sender@example.test" is linked to "sam@example.com" in "Anthus Labs"
    And the model will answer "The research is done."
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the operator switches external channels off for the organization "Anthus Labs"
    And the bot "Researcher" completes its turn
    Then no delivery was recorded
    And the event bus received 0 events

  Scenario: A turn started in the web app announces nothing even where channels are open
    Given the deployment releases the kill switch
    And the deployment composes external channels
    And the operator switches external channels on for the organization "Anthus Labs"
    And "sam@example.com" has a direct channel with the bot "Researcher" in "Anthus Labs"
    And the model will answer "From the web."
    When "sam@example.com" posts "Hello" on that channel addressed to the bot "Researcher"
    And the bot "Researcher" completes its turn
    Then no delivery was recorded
    And the event bus received 0 events

  Scenario: The composed runtime delivers email through the real transport and not through a missing one
    Given the deployment releases the kill switch
    When the deployment composes external channels
    Then the composed runtime has an email transport

  Scenario: The plus-tag secret is read from its parameter by the exact name and no other parameter is read
    Given the deployment releases the kill switch
    When the deployment composes external channels
    Then the deployment read exactly the parameter "/chatticus/test/channels/correlator-secret"

  Scenario Outline: A broken channel setting keeps channels closed and leaves ordinary traffic unaffected
    Given the deployment releases the kill switch
    And the deployment is broken by "<breakage>"
    When the deployment composes external channels
    Then the front door logged 1 channel composition error that names "<named>" and holds no secret
    And the front door answers its health route
    When "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the channel request is answered as not found
    When the operator switches external channels on for the organization "Anthus Labs"
    And "sam@example.com" has a direct channel with the bot "Researcher" in "Anthus Labs"
    And the model will answer "From the web."
    And "sam@example.com" posts "Hello" on that channel addressed to the bot "Researcher"
    And the bot "Researcher" completes its turn
    Then that channel has 2 messages
    And the event bus received 0 events

    Examples:
      | breakage                           | named                                               |
      | an invalid kill switch value       | CHATTICUS_CHANNELS_KILL_SWITCH                      |
      | an empty secret parameter          | /chatticus/test/channels/correlator-secret          |
      | a missing secret parameter name    | CHATTICUS_CHANNELS_CORRELATOR_SECRET_PARAMETER_NAME |
      | a missing event bus name           | CHATTICUS_CHANNELS_EVENT_BUS_NAME                   |
      | a missing configuration set name   | CHATTICUS_CHANNELS_CONFIGURATION_SET_NAME           |
      | a missing web app base URL         | CHATTICUS_CHANNELS_WEB_APP_BASE_URL                 |

  Scenario: A transient parameter read failure heals on the next interval without a redeploy
    Given the deployment releases the kill switch
    And the parameter store fails its reads
    When the deployment composes external channels
    Then the front door logged 1 channel composition error that names "ThrottlingException" and holds no secret
    When "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the channel request is answered as not found
    When the parameter store recovers
    And the clock moves forward 30 seconds
    And "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the channel request is answered as not found
    And the front door logged 1 channel composition error that names "ThrottlingException" and holds no secret
    When the clock moves forward 31 seconds
    And the operator switches external channels on for the organization "Anthus Labs"
    And "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the channel request is accepted

  Scenario: A failure that lasts is logged once per interval and not once per request
    Given the deployment releases the kill switch
    And the parameter store fails its reads
    When the deployment composes external channels
    And "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    And "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the front door logged 1 channel composition error that names "ThrottlingException" and holds no secret
    When the clock moves forward 61 seconds
    And "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the front door logged 2 channel composition errors that name "ThrottlingException" and hold no secret

  Scenario: A broken kill switch value at the executor logs one error and ordinary turns complete
    Given the deployment sets the kill switch to "maybe"
    When the deployment composes external channels
    And "sam@example.com" has a direct channel with the bot "Researcher" in "Anthus Labs"
    And the model will answer "From the web."
    And "sam@example.com" posts "Hello" on that channel addressed to the bot "Researcher"
    And the bot "Researcher" completes its turn
    Then that channel has 2 messages
    And the executor logged 1 channel composition error

  Scenario: A bus that refuses the event does not fail the turn and the delivery stays recorded
    Given the deployment releases the kill switch
    And the deployment composes external channels
    And the operator switches external channels on for the organization "Anthus Labs"
    And "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And "ryan@example.com" has created an email binding for the bot "Researcher" in "Anthus Labs"
    And the email sender "sam.sender@example.test" is linked to "sam@example.com" in "Anthus Labs"
    And the model will answer "The research is done."
    And the event bus refuses every event
    When an email arrives:
      | from    | sam.sender@example.test                     |
      | to      | researcher@anthus.mail.develop.example.test |
      | subject | Quarterly plan                              |
      | id      | root-1@mail.example.test                    |
      | body    | Where do we start?                          |
    And the bot "Researcher" completes its turn
    Then 1 delivery was recorded
    And the executor logged 1 event publish failure naming ids only
