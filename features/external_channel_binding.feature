Feature: Owners bind external endpoints to their bots
  As an owner of an organization
  I want to attach an external address to one of my bots
  So that people can reach the bot over a channel other than the web app, and nobody outside the organization can see or change that

  Each organization chooses a mail handle once. An email binding is then the bot's address, bot name at the handle at the
  environment's mail domain. Owners change bindings, members read them, and anyone else gets the same not found they would
  get for a route that does not exist. External channels are switched on per organization by the operator, and the whole
  environment can be switched off with one kill switch. The contract is docs/EXTERNAL_CHANNELS.md.

  Background:
    Given an empty control plane
    And external channels are configured for this environment with the mail domain "mail.develop.example.test"
    And the organization "Anthus Labs" has the owners "ryan@example.com" and "ada@example.com" and the member "sam@example.com"
    And the organization "Other House" has the owner "olive@example.org"
    And the organization "Anthus Labs" has the bot "Researcher"
    And external channels are switched on for the organization "Anthus Labs"

  Scenario: An owner chooses a mail handle and binds a bot to an address
    When "ryan@example.com" chooses the mail handle "anthus" for "Anthus Labs"
    Then the channel request is accepted
    When "ryan@example.com" creates an email binding for the bot "Researcher" in "Anthus Labs"
    Then the channel request is accepted
    And the binding address is "researcher@anthus.mail.develop.example.test"
    And the binding is enabled

  Scenario: A bot name becomes an address local part
    Given the organization "Anthus Labs" has the bot "Lead Analyst"
    And "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    When "ryan@example.com" creates an email binding for the bot "Lead Analyst" in "Anthus Labs"
    Then the binding address is "lead-analyst@anthus.mail.develop.example.test"

  Scenario: An email binding needs a mail handle first
    When "ryan@example.com" creates an email binding for the bot "Researcher" in "Anthus Labs"
    Then the channel request is refused with the status 409 and the code "mail_handle_required"

  Scenario Outline: A mail handle must be a lowercase DNS label that is not a reserved word
    When "ryan@example.com" chooses the mail handle "<handle>" for "Anthus Labs"
    Then the channel request is refused with the status 422 and the code "<code>"

    Examples:
      | handle        | code                 |
      | Anthus Labs   | mail_handle_invalid  |
      | -anthus       | mail_handle_invalid  |
      | anthus.labs   | mail_handle_invalid  |
      | postmaster    | mail_handle_reserved |
      | support       | mail_handle_reserved |

  Scenario: Two organizations cannot claim the same mail handle
    Given "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And external channels are switched on for the organization "Other House"
    When "olive@example.org" chooses the mail handle "anthus" for "Other House"
    Then the channel request is refused with the status 409 and the code "mail_handle_taken"

  Scenario: Two organizations cannot claim the same route key
    Given external channels are switched on for the organization "Other House"
    And the organization "Other House" has the bot "Assistant"
    And "ryan@example.com" has created a fake binding for the bot "Researcher" in "Anthus Labs" with the route key "line-one"
    When "olive@example.org" creates a fake binding for the bot "Assistant" in "Other House" with the route key "Line-One"
    Then the channel request is refused with the status 409 and the code "route_taken"

  Scenario: An external identity equal to a route key cannot be linked
    Given the fake route "researcher-line" of "Anthus Labs" is bound to the bot "Researcher"
    When "ryan@example.com" links the fake sender "Researcher-Line" to "sam@example.com" in "Anthus Labs"
    Then the channel request is refused with the status 422 and the code "identity_is_a_route"
    When "ryan@example.com" links the fake sender "sam-phone" to "sam@example.com" in "Anthus Labs"
    Then the channel request is accepted

  Scenario: A member can read bindings but not change them
    Given "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And "ryan@example.com" has created an email binding for the bot "Researcher" in "Anthus Labs"
    When "sam@example.com" lists the channel bindings of "Anthus Labs"
    Then the channel request is accepted
    And the listed bindings number 1
    When "sam@example.com" creates an email binding for the bot "Researcher" in "Anthus Labs"
    Then the channel request is refused as forbidden
    When "sam@example.com" disables the binding of the bot "Researcher" in "Anthus Labs"
    Then the channel request is refused as forbidden
    When "sam@example.com" chooses the mail handle "samshandle" for "Anthus Labs"
    Then the channel request is refused as forbidden

  Scenario: A member of another organization finds nothing
    Given "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And "ryan@example.com" has created an email binding for the bot "Researcher" in "Anthus Labs"
    When "olive@example.org" lists the channel bindings of "Anthus Labs"
    Then the channel request is answered as not found
    When "olive@example.org" creates an email binding for the bot "Researcher" in "Anthus Labs"
    Then the channel request is answered as not found

  Scenario: An owner who is removed loses access at the next request
    Given "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And "ada@example.com" has read the channel bindings of "Anthus Labs"
    When "ryan@example.com" removes "ada@example.com" from "Anthus Labs"
    And "ada@example.com" lists the channel bindings of "Anthus Labs"
    Then the channel request is answered as not found

  Scenario: A bot of another organization cannot be bound
    Given the organization "Other House" has the bot "Assistant"
    And "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    When "ryan@example.com" creates a fake binding for the bot "Assistant" in "Anthus Labs" with the route key "line-two"
    Then the channel request is answered as not found

  Scenario: An organization the operator has not switched on does not see the feature
    Given the organization "Other House" has the bot "Assistant"
    When "olive@example.org" lists the channel bindings of "Other House"
    Then the channel request is answered as not found
    When "olive@example.org" chooses the mail handle "otherhouse" for "Other House"
    Then the channel request is answered as not found

  Scenario: The operator switches external channels on and off for an organization
    When the operator switches external channels off for the organization "Anthus Labs"
    Then the operator request is accepted
    When "ryan@example.com" lists the channel bindings of "Anthus Labs"
    Then the channel request is answered as not found
    When the operator switches external channels on for the organization "Anthus Labs"
    And "ryan@example.com" lists the channel bindings of "Anthus Labs"
    Then the channel request is accepted

  Scenario: The environment kill switch hides the feature from every organization
    Given the environment kill switch for external channels is engaged
    When "ryan@example.com" lists the channel bindings of "Anthus Labs"
    Then the channel request is answered as not found

  Scenario: Disabling a binding keeps it and its address
    Given "ryan@example.com" has chosen the mail handle "anthus" for "Anthus Labs"
    And "ryan@example.com" has created an email binding for the bot "Researcher" in "Anthus Labs"
    When "ryan@example.com" disables the binding of the bot "Researcher" in "Anthus Labs"
    Then the channel request is accepted
    And the binding is disabled
    When "sam@example.com" reads the binding of the bot "Researcher" in "Anthus Labs"
    Then the binding address is "researcher@anthus.mail.develop.example.test"
    And the binding is disabled

  Scenario: An environment without the feature answers as if it did not exist
    Given external channels are not configured for this environment
    When "ryan@example.com" lists the channel bindings of "Anthus Labs"
    Then the channel request is answered as not found
