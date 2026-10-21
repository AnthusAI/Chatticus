Feature: A role cannot reach a store path that the role access manifest and its policy do not both cover
  As the operator of the control plane
  I want every request shape the Front Door, the per-turn owner and the supervisor make to be listed and allowed
  So that a new S3 key or DynamoDB partition cannot ship with a policy that real AWS would refuse

  The in-memory and moto-backed stores that the scenarios run on enforce no IAM
  policy, so a request that real AWS would refuse passes every scenario. On
  2026-10-13 a read of a missing snapshot object answered 403 AccessDenied
  instead of 404 NoSuchKey because the Front Door could list the bucket only
  under a prefix condition, and every computer start failed until the image was
  rolled back. The role access manifest lists each request shape of each role:
  its action, its store and the shape of its key. After every scenario the
  requests the recording clients noted for the Front Door, the per-turn owner
  and the supervisor must each match a row, and a read of an object that did not
  exist may not hit a row that claims the key always exists. These scenarios
  judge the manifest itself: that the policy files the stack deploys allow every
  row, that a request without a row is refused with its role, action and key,
  and that a policy which would answer 403 for a missing key is refused. The
  infra tests judge the same rows against the policies the stack synthesizes.

  Scenario: The policy files the stack deploys allow every row of the manifest for the roles they define
    Given the role access manifest
    Then every manifest row of the role "ownerTurn" is served by the owner role policy file
    And every manifest row of the role "supervisor" is served by the supervisor role policy file
    And every manifest row of the role "frontDoor" on the snapshot bucket is served by the Front Door snapshot role policy file

  Scenario: A request that no manifest row describes fails the check and names its role, action and key
    Given the role access manifest
    When the role "frontDoor" makes "s3:PutObject" on the "piSessionsBucket" key "conversations/anthus%23bot-1%23channel-1/commits/000000000001-00000001.json"
    Then the access check fails with "frontDoor made s3:PutObject on piSessionsBucket key conversations/anthus%23bot-1%23channel-1/commits/000000000001-00000001.json, which role-access-manifest.json does not list"

  Scenario: A request of the right action on a key shape no row describes also fails
    Given the role access manifest
    When the role "ownerTurn" makes "dynamodb:GetItem" on the "messagingTable" key "anthus#budget#secret"
    Then the access check fails with "ownerTurn made dynamodb:GetItem on messagingTable key anthus#budget#secret"

  Scenario: A request the manifest describes passes the check
    Given the role access manifest
    When the role "supervisor" makes "s3:PutObject" on the "snapshotBucket" key "tenants/anthus/computers/computer-1/snapshot.tar.gz"
    Then the access check passes

  Scenario: A manifest row that the role's policy denies is reported
    Given a manifest with these rows:
      | role       | action          | store          | keyPattern                    | exampleKey                              | keyAlwaysExists |
      | supervisor | s3:ListBucket   | snapshotBucket | ^tenants/                     | tenants/{tenantId}/                     |                 |
      | supervisor | s3:PutObject    | snapshotBucket | ^tenants/[^/]+/computers/.+$  | tenants/{tenantId}/computers/{computerId}/snapshot.tar.gz | true |
    Then the supervisor role policy file refuses exactly the row "supervisor s3:ListBucket on snapshotBucket key tenants/anthus/" because "is denied by the policy"

  Scenario: A read of a key that may be missing is refused when the role cannot list the bucket without a prefix
    Given a manifest with these rows:
      | role      | action       | store          | keyPattern                | exampleKey                                                         | keyAlwaysExists |
      | ownerTurn | s3:GetObject | piSessionsBucket | ^conversations/[^/]+/.+$ | conversations/{tenantId}%23{botId}%23{channelId}/commits/1.json |                 |
    Then the owner role policy file refuses exactly the row "ownerTurn s3:GetObject on piSessionsBucket key conversations/anthus%23bot-1%23channel-1/commits/1.json" because "would answer 403 AccessDenied for a missing key"

  Scenario: A read of a key that always exists needs no listing permission
    Given a manifest with these rows:
      | role      | action       | store          | keyPattern                | exampleKey                                                         | keyAlwaysExists |
      | ownerTurn | s3:GetObject | piSessionsBucket | ^conversations/[^/]+/.+$ | conversations/{tenantId}%23{botId}%23{channelId}/commits/1.json | true            |
    Then the owner role policy file serves every row

  Scenario: A read of a missing object on a row that claims the key always exists is reported
    Given a manifest with these rows:
      | role      | action       | store          | keyPattern                | exampleKey                                                         | keyAlwaysExists |
      | ownerTurn | s3:GetObject | piSessionsBucket | ^conversations/[^/]+/.+$ | conversations/{tenantId}%23{botId}%23{channelId}/commits/1.json | true            |
    When the role "ownerTurn" reads the missing key "conversations/anthus%23bot-1%23channel-1/commits/1.json" of the "piSessionsBucket"
    Then the access check fails with "ownerTurn read a key that did not exist"

  Scenario Outline: The owner and the supervisor are denied every read of the secret parameters, history included
    Given the role access manifest
    Then the "<role>" role policy file denies "<action>" on every secret parameter the manifest lists

    Examples:
      | role       | action                   |
      | ownerTurn  | ssm:GetParameter         |
      | ownerTurn  | ssm:GetParameters        |
      | ownerTurn  | ssm:GetParameterHistory  |
      | supervisor | ssm:GetParameter         |
      | supervisor | ssm:GetParameters        |
      | supervisor | ssm:GetParameterHistory  |

  Scenario: The manifest lists the operator key and the signing key as parameters no per-turn role may read
    Given the role access manifest
    Then the manifest denies the roles "ownerTurn" and "supervisor" the parameters "operatorKeyParameter" and "signingKeyParameter"
    And the manifest denies the actions "ssm:GetParameter", "ssm:GetParameters" and "ssm:GetParameterHistory"
