Feature: A generated runtime key is created once as an SSM SecureString by infrastructure code and never shown
  As the operator of the control plane
  I want a deploy to create the operator key and the model gateway signing key as SSM Parameter Store SecureStrings
  So that no one types a generated key by hand, the key never appears in a template or a log, and a later deploy never changes it

  The GeneratedSecureString resource is a CloudFormation custom resource backed
  by one small Lambda. On Create it generates a random value, stores it as a
  standard-tier SecureString under the default aws/ssm key and refuses to
  overwrite. When the parameter already exists it adopts that parameter
  unchanged, which is how a value placed by hand before the deploy survives.
  On Update and on Delete it does nothing, because the parameter is retained and
  a key is only replaced on purpose. The answer to CloudFormation carries the
  parameter name and a version, never the value, and nothing the Lambda prints
  carries the value.

  Background:
    Given the SSM parameter store holds nothing

  Scenario: Create generates a random key and stores it as a standard SecureString without overwriting
    When CloudFormation creates the generated key "/chatticus/development/thin-turn/operator-key" of 32 characters
    Then the parameter "/chatticus/development/thin-turn/operator-key" is a standard-tier SecureString of 32 characters
    And every character of the stored key is a letter or a digit
    And the parameter was written with overwrite off
    And the answer names the parameter "/chatticus/development/thin-turn/operator-key" and its version and holds no other data

  Scenario: Each create generates a different key
    When CloudFormation creates the generated key "/chatticus/development/thin-turn/operator-key" of 32 characters
    And CloudFormation creates the generated key "/chatticus/staging/thin-turn/operator-key" of 32 characters
    Then the keys stored in the two parameters differ

  Scenario: Create adopts a parameter that already exists and leaves its value unchanged
    Given the parameter "/chatticus/development/model-gateway/signing-key" already holds a SecureString that was placed by hand
    When CloudFormation creates the generated key "/chatticus/development/model-gateway/signing-key" of 64 characters
    Then the parameter "/chatticus/development/model-gateway/signing-key" still holds the value that was placed by hand
    And the answer names the parameter "/chatticus/development/model-gateway/signing-key" and its version and holds no other data

  Scenario: Update changes nothing
    Given the parameter "/chatticus/development/thin-turn/operator-key" already holds a SecureString that was placed by hand
    When CloudFormation updates the generated key "/chatticus/development/thin-turn/operator-key" of 32 characters
    Then the parameter "/chatticus/development/thin-turn/operator-key" still holds the value that was placed by hand
    And the Lambda made no call to SSM

  Scenario: Delete changes nothing, because the parameter is retained
    Given the parameter "/chatticus/development/thin-turn/operator-key" already holds a SecureString that was placed by hand
    When CloudFormation deletes the generated key "/chatticus/development/thin-turn/operator-key" of 32 characters
    Then the parameter "/chatticus/development/thin-turn/operator-key" still holds the value that was placed by hand
    And the Lambda made no call to SSM

  Scenario: A key too short to be safe is refused before anything is written
    When CloudFormation creates the generated key "/chatticus/development/thin-turn/operator-key" of 16 characters
    Then the Lambda refuses with a message that names the minimum length 32
    And the Lambda made no call to SSM

  Scenario: A refused write is reported without the key
    Given SSM refuses the write with the error "AccessDeniedException"
    When CloudFormation creates the generated key "/chatticus/development/thin-turn/operator-key" of 32 characters
    Then the Lambda refuses with a message that holds no key

  Scenario: Nothing the Lambda prints carries a key
    Given the parameter "/chatticus/development/model-gateway/signing-key" already holds a SecureString that was placed by hand
    When CloudFormation creates the generated key "/chatticus/development/thin-turn/operator-key" of 32 characters
    And CloudFormation creates the generated key "/chatticus/development/model-gateway/signing-key" of 64 characters
    Then nothing the Lambda printed holds a generated key or the value that was placed by hand
