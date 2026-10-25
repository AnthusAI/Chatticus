Feature: The computer owner role reaches one conversation session and nothing else
  As the operator of an organization computer
  I want the credentials a turn child receives to reach one conversation session and a short list of
  key families of its organization
  So that an owner whose credentials leak cannot rewrite the organization, the roster or any other conversation

  The credential broker assumes ComputerOwnerScopedRole for each dispatched turn with five session tags: tenant,
  bot, channel, computer and turn. The role carries one static permission
  policy, the file the CDK stack deploys, written with policy variables such as
  the tenant tag. These scenarios take the statements of that file, substitute
  the tag values the way IAM does, and ask whether each request is allowed.
  The owner may write the key families of its turn, its channel, its computer
  record and actions, its ledger and the monthly cost index of its organization and its own mailbox; it may only read the
  organization record and the budget rollup and look up one roster item (its bot); every other family,
  every other tenant, bot, channel and computer, and every action that carries
  no key (Scan, a batch write) are denied.

  Background:
    Given the owner role of bot "bot-1" in channel "channel-1" of organization "anthus" on computer "computer-1" in turn "turn-1"

  Scenario Outline: The owner writes the key families of its own organization and session
    When the owner requests "<action>" on the "messaging" table for the keys "<key>"
    Then the owner role allows the request

    Examples:
      | action              | key                          |
      | dynamodb:GetItem    | anthus#turn#0000000004       |
      | dynamodb:PutItem    | anthus#turn#0000000004       |
      | dynamodb:UpdateItem | anthus#turn#0000000004       |
      | dynamodb:Query      | anthus#turn#0000000004       |
      | dynamodb:GetItem    | anthus#channel#channel-1     |
      | dynamodb:UpdateItem | anthus#channel#channel-1     |
      | dynamodb:DeleteItem | anthus#channel#channel-1     |
      | dynamodb:GetItem    | anthus#computer#actions      |
      | dynamodb:PutItem    | anthus#computer#actions      |
      | dynamodb:UpdateItem | anthus#computer#actions      |
      | dynamodb:GetItem    | anthus#computer#record       |
      | dynamodb:UpdateItem | anthus#computer#record       |
      | dynamodb:GetItem    | anthus#vendor_ledger         |
      | dynamodb:PutItem    | anthus#vendor_ledger         |
      | dynamodb:GetItem    | anthus#cost#2026-10          |
      | dynamodb:UpdateItem | anthus#cost#2026-10          |
      | dynamodb:Query      | anthus#cost#2026-10          |
      | dynamodb:Query      | MB#anthus#bot-1#channel-1    |
      | dynamodb:DeleteItem | MB#anthus#bot-1#channel-1    |

  Scenario Outline: The owner reads the organization record, the budget rollup and, one item at a time, the roster, and writes none of them
    When the owner requests "<action>" on the "messaging" table for the keys "<key>"
    Then the owner role <verdict> the request

    Examples:
      | action                       | key                    | verdict |
      | dynamodb:GetItem             | anthus#org             | allows  |
      | dynamodb:Query               | anthus#org             | allows  |
      | dynamodb:GetItem             | anthus#budget_rollup   | allows  |
      | dynamodb:GetItem             | anthus#roster          | allows  |
      | dynamodb:Query               | anthus#roster          | denies  |
      | dynamodb:PutItem             | anthus#roster          | denies  |
      | dynamodb:UpdateItem          | anthus#roster          | denies  |
      | dynamodb:DeleteItem          | anthus#roster          | denies  |
      | dynamodb:ConditionCheckItem  | anthus#roster          | denies  |
      | dynamodb:PutItem             | anthus#org             | denies  |
      | dynamodb:UpdateItem          | anthus#org             | denies  |
      | dynamodb:DeleteItem          | anthus#org             | denies  |
      | dynamodb:ConditionCheckItem  | anthus#org             | denies  |
      | dynamodb:PutItem             | anthus#budget_rollup   | denies  |
      | dynamodb:UpdateItem          | anthus#budget_rollup   | denies  |
      | dynamodb:DeleteItem          | anthus#budget_rollup   | denies  |

  Scenario Outline: The owner cannot touch what the gateway observed, because that is the evidence its own cost is checked against
    When the owner requests "<action>" on the "messaging" table for the keys "<key>"
    Then the owner role denies the request

    Examples:
      | action              | key                          |
      | dynamodb:GetItem    | anthus#cost#observed         |
      | dynamodb:Query      | anthus#cost#observed         |
      | dynamodb:PutItem    | anthus#cost#observed         |
      | dynamodb:UpdateItem | anthus#cost#observed         |
      | dynamodb:DeleteItem | anthus#cost#observed         |
      | dynamodb:PutItem    | anthus#cost#channel#channel-1 |
      | dynamodb:PutItem    | other#cost#2026-10           |

  Scenario Outline: The owner cannot touch any other family of its own organization
    When the owner requests "<action>" on the "messaging" table for the keys "<key>"
    Then the owner role denies the request

    Examples:
      | action              | key                      |
      | dynamodb:GetItem    | anthus#approvals         |
      | dynamodb:PutItem    | anthus#rules             |
      | dynamodb:PutItem    | anthus#connections       |
      | dynamodb:GetItem    | anthus#task#task-1       |
      | dynamodb:GetItem    | anthus#computer#other    |
      | dynamodb:GetItem    | user#ryan                |
      | dynamodb:PutItem    | user#ryan                |
      | dynamodb:GetItem    | channel_lookup#channel-1 |

  Scenario Outline: The owner cannot reach another organization, another bot's mailbox or another channel's mailbox
    When the owner requests "<action>" on the "messaging" table for the keys "<key>"
    Then the owner role denies the request

    Examples:
      | action              | key                          |
      | dynamodb:GetItem    | other#turn#0000000004        |
      | dynamodb:PutItem    | other#channel#channel-1      |
      | dynamodb:UpdateItem | other#computer#record        |
      | dynamodb:GetItem    | other#org                    |
      | dynamodb:PutItem    | other#org                    |
      | dynamodb:GetItem    | other#roster                 |
      | dynamodb:GetItem    | anthus2#turn#0000000004      |
      | dynamodb:Query      | MB#anthus#bot-2#channel-1    |
      | dynamodb:DeleteItem | MB#anthus#bot-1#channel-2    |
      | dynamodb:Query      | MB#other#bot-1#channel-1     |

  Scenario: A request that names one foreign key among its own keys is denied
    When the owner requests "dynamodb:BatchGetItem" on the "conversations" table for the keys "PI#anthus#bot-1#channel-1,PI#anthus#bot-1#channel-2"
    Then the owner role denies the request

  Scenario Outline: The owner reads and writes the items of its own conversation session
    When the owner requests "<action>" on the "conversations" table for the keys "PI#anthus#bot-1#channel-1"
    Then the owner role allows the request

    Examples:
      | action                      |
      | dynamodb:GetItem            |
      | dynamodb:BatchGetItem       |
      | dynamodb:PutItem            |
      | dynamodb:UpdateItem         |
      | dynamodb:DeleteItem         |
      | dynamodb:Query              |
      | dynamodb:ConditionCheckItem |

  Scenario Outline: The owner cannot reach another conversation session
    When the owner requests "dynamodb:GetItem" on the "conversations" table for the keys "<key>"
    Then the owner role denies the request

    Examples:
      | key                        |
      | PI#anthus#bot-1#channel-2  |
      | PI#anthus#bot-2#channel-1  |
      | PI#other#bot-1#channel-1   |
      | PI#anthus#bot-1#channel-10 |

  Scenario Outline: The owner takes no action that carries no key
    When the owner requests "<action>" on the "<table>" table with no key
    Then the owner role denies the request

    Examples:
      | action                        | table         |
      | dynamodb:Scan                 | messaging     |
      | dynamodb:Scan                 | conversations |
      | dynamodb:BatchWriteItem       | messaging     |
      | dynamodb:BatchWriteItem       | conversations |
      | dynamodb:BatchGetItem         | messaging     |
      | dynamodb:DescribeTable        | messaging     |
      | dynamodb:DeleteTable          | messaging     |
      | dynamodb:ExportTableToPointInTime | messaging |

  Scenario Outline: The owner reaches the objects of its own session in the sessions bucket
    When the owner requests "<action>" on the object "<key>" of bucket "<bucket>"
    Then the owner role allows the request

    Examples:
      | action          | bucket      | key                                                  |
      | s3:GetObject    | pi-sessions | conversations/anthus%23bot-1%23channel-1/commits/1.json |
      | s3:PutObject    | pi-sessions | conversations/anthus%23bot-1%23channel-1/commits/1.json |
      | s3:DeleteObject | pi-sessions | conversations/anthus%23bot-1%23channel-1/commits/1.json |

  Scenario Outline: The owner cannot reach the snapshot of any computer, nor the objects of another tenant, bot or channel
    When the owner requests "<action>" on the object "<key>" of bucket "<bucket>"
    Then the owner role denies the request

    Examples:
      | action          | bucket      | key                                                      |
      | s3:GetObject    | pi-sessions | conversations/anthus%23bot-1%23channel-2/commits/1.json  |
      | s3:PutObject    | pi-sessions | conversations/anthus%23bot-2%23channel-1/commits/1.json  |
      | s3:DeleteObject | pi-sessions | conversations/other%23bot-1%23channel-1/commits/1.json   |
      | s3:GetObject    | pi-sessions | conversations/anthus%23bot-1%23channel-10/commits/1.json |
      | s3:GetObject    | pi-sessions | other/anthus%23bot-1%23channel-1/commits/1.json          |
      | s3:GetObject    | snapshots   | tenants/anthus/computers/computer-1/manifest.json        |
      | s3:PutObject    | snapshots   | tenants/anthus/computers/computer-1/snapshot.tar.gz      |
      | s3:GetObject    | snapshots   | tenants/other/computers/computer-1/manifest.json         |
      | s3:GetObject    | snapshots   | tenants/anthus/computers/computer-2/manifest.json        |
      | s3:PutObject    | snapshots   | tenants/anthus/computers/computer-10/manifest.json       |
      | s3:DeleteObject | snapshots   | tenants/anthus/computers/computer-1/manifest.json        |
      | s3:GetObject    | other-bucket | conversations/anthus%23bot-1%23channel-1/commits/1.json |
      | s3:GetObject    | snapshots   | tenants/anthus/computers/computer-1/overlay/index.json   |
      | s3:PutObject    | snapshots   | tenants/anthus/computers/computer-1/overlay/index.json   |
      | s3:DeleteObject | snapshots   | tenants/anthus/computers/computer-1/overlay/index.json   |
      | s3:GetObject    | snapshots   | tenants/anthus/computers/computer-1/overlay/blobs/abc    |
      | s3:PutObject    | snapshots   | tenants/anthus/computers/computer-1/overlay/blobs/abc    |
      | s3:DeleteObject | snapshots   | tenants/anthus/computers/computer-1/overlay/blobs/abc    |

  Scenario Outline: The owner lists only the prefix of its own session
    When the owner lists bucket "<bucket>" with the prefix "<prefix>"
    Then the owner role <verdict> the request

    Examples:
      | bucket      | prefix                                      | verdict |
      | pi-sessions | conversations/anthus%23bot-1%23channel-1/   | allows  |
      | pi-sessions | conversations/anthus%23bot-1%23channel-2/   | denies  |
      | pi-sessions | conversations/                              | denies  |
      | pi-sessions |                                             | denies  |
      | snapshots   | tenants/anthus/computers/computer-1/        | denies  |

  Scenario Outline: The owner takes no action outside S3 and DynamoDB and cannot read a key parameter or its history
    When the owner requests "<action>" on the resource "<resource>"
    Then the owner role denies the request

    Examples:
      | action                         | resource                                                                                      |
      | ssm:GetParameter               | arn:aws:ssm:us-east-1:111111111111:parameter/chatticus/development/model-gateway/signing-key |
      | ssm:GetParameterHistory        | arn:aws:ssm:us-east-1:111111111111:parameter/chatticus/development/model-gateway/signing-key |
      | ssm:GetParameter               | arn:aws:ssm:us-east-1:111111111111:parameter/chatticus/development/thin-turn/operator-key    |
      | ssm:GetParameterHistory        | arn:aws:ssm:us-east-1:111111111111:parameter/chatticus/development/thin-turn/operator-key    |

  Scenario: The policy file the stack deploys holds no tenant-wide wildcard, no Scan and no unnamed resource
    Then the owner role statements hold no action that carries no key
    And the owner role statements hold no key pattern that ends in a bare tenant wildcard
    And the owner role statements give the roster nothing but GetItem
    And every resource of the owner role statements is a store of the role or an object path built from session tags
