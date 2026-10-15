Feature: The credential broker has a development-only fault switch and renewal adds no permission to any role
  As an operator of the development environment
  I want to make the broker refuse or shorten renewals, so that a failed renewal can be proved live in fifteen minutes
  So that no switch like that can exist in staging or production, and renewing credentials changes nothing the roles may touch

  The OwnerCredentialBroker can be told, in development only, to deny a purpose
  or to cap the credential duration between 900 and 3600 seconds. The switch can
  only make the broker issue less: it never lengthens a session and never changes
  who is authorized. Four gates keep it out of production. The deployment reads
  the CDK context "ownerBrokerFault" and "ownerBrokerCredentialSeconds" only for
  the development environment and fails synthesis, naming the switch, for any other
  (G1). The two broker variables are emitted only in development, and the broker's
  environment always holds CHATTICUS_ENVIRONMENT (G2). The broker's fault module
  throws at start when a variable is set and the environment is not exactly
  development, so every invocation fails (G3). A fault never widens what is
  issued (G4). The renewal itself is told in owner_credential_broker.feature, and
  renewal changes no role: the broker holds the same permissions and the two
  owner roles keep their trust and their one hour limit. Staging and production
  hold no owner broker yet, so there is nothing there to hold a variable, and
  their templates name neither of them anywhere.

  @broker
  Scenario: The development fault switch denies a renewal and shortens the credentials
    Given the broker holds the signing key
    And the broker runs in the environment "development" with the fault "deny_supervisor_renewal"
    When the broker is asked for supervisor renewal credentials with a valid supervisor token
    Then the broker answers not ok with the code "assume_role_failed"
    And STS was not asked to assume a role
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the role "ComputerSupervisorRole" was assumed for 3600 seconds
    Given the broker runs in the environment "development" with credentials limited to 900 seconds
    When the broker is asked for supervisor credentials with a valid bootstrap token
    Then the role "ComputerSupervisorRole" was assumed for 900 seconds
    And the credentials, the token and the token's expiry end at the same moment
    Given the broker runs in the environment "development" with credentials limited to 7200 seconds
    Then the broker refuses to start

  @broker
  Scenario Outline: The broker refuses to start with a fault switch outside development
    Given the broker holds the signing key
    When the broker is started in the environment <environment> with the fault "deny_supervisor_renewal"
    Then the broker refuses to start
    And every invocation of the deployed entry point fails
    And STS was not asked to assume a role

    Examples:
      | environment  |
      | "production" |
      | "staging"    |
      | ""           |
      | not set      |

  @infra
  Scenario: Renewal adds no permission to the broker and no role changes its trust or session limit
    Given the synthesized control plane stack
    Then the broker's role holds the permission to read the signing key and to assume the two owner roles and nothing else
    And the supervisor role and the per-turn role still trust only the broker's role with their exact session tag keys
    And both roles keep a maximum session of 3600 seconds

  @infra
  Scenario Outline: The staging and production templates hold no fault variable
    Given the control plane stack synthesized for <environment>
    Then the template names neither "CHATTICUS_OWNER_BROKER_FAULT" nor "CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS"
    And the template holds no owner credential broker

    Examples:
      | environment |
      | staging     |
      | production  |

  @infra
  Scenario: The development broker knows its environment
    Given the synthesized control plane stack
    Then the broker's environment holds "CHATTICUS_ENVIRONMENT" set to "development"
    And the broker's environment holds neither "CHATTICUS_OWNER_BROKER_FAULT" nor "CHATTICUS_OWNER_BROKER_CREDENTIAL_SECONDS"

  @infra
  Scenario Outline: The broker's development fault switch exists in development only
    Given the control plane stack synthesized for <environment> with the broker fault switch set
    Then the synthesis <outcome>

    Examples:
      | environment | outcome                         |
      | development | sets the broker's environment   |
      | staging     | fails and names the switch      |
      | production  | fails and names the switch      |
