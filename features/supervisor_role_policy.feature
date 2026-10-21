Feature: The computer supervisor role reaches the snapshot of one computer and nothing else
  As the operator of an organization computer
  I want the credentials a container supervisor receives to read and write the snapshot of its own computer and nothing more
  So that a supervisor whose credentials leak cannot read a conversation, rewrite the organization or touch another computer

  The credential broker assumes ComputerSupervisorRole with two session tags:
  tenant and computer. The role carries one static permission policy, the file
  the CDK stack deploys, written with the policy variables for those two tags.
  These scenarios take the statements of that file, substitute the tag values
  the way IAM does, and ask whether each request is allowed. The supervisor may
  get, put and abort a multipart upload of objects under the snapshot prefix of
  its own organization and computer. Every other object, tenant and computer,
  every other bucket, every table, every listing and every delete is denied.

  Background:
    Given the supervisor role of organization "anthus" on computer "computer-1"

  Scenario Outline: The supervisor reads and writes the snapshot of its own computer
    When the supervisor requests "<action>" on the object "<key>" of bucket "snapshots"
    Then the supervisor role allows the request

    Examples:
      | action                  | key                                                 |
      | s3:GetObject            | tenants/anthus/computers/computer-1/manifest.json   |
      | s3:PutObject            | tenants/anthus/computers/computer-1/snapshot.tar.gz |
      | s3:AbortMultipartUpload | tenants/anthus/computers/computer-1/snapshot.tar.gz |

  Scenario Outline: The supervisor cannot reach the snapshot of another computer or another organization
    When the supervisor requests "<action>" on the object "<key>" of bucket "snapshots"
    Then the supervisor role denies the request

    Examples:
      | action                  | key                                                  |
      | s3:GetObject            | tenants/anthus/computers/computer-2/manifest.json    |
      | s3:PutObject            | tenants/anthus/computers/computer-10/manifest.json   |
      | s3:AbortMultipartUpload | tenants/anthus/computers/computer-2/snapshot.tar.gz  |
      | s3:GetObject            | tenants/other/computers/computer-1/manifest.json     |
      | s3:PutObject            | tenants/other/computers/computer-1/manifest.json     |
      | s3:GetObject            | tenants/anthus2/computers/computer-1/manifest.json   |
      | s3:GetObject            | tenants/anthus/computers/computer-1                  |
      | s3:GetObject            | tenants/anthus/manifest.json                         |
      | s3:GetObject            | other/anthus/computers/computer-1/manifest.json      |

  Scenario Outline: The supervisor can neither delete nor list nor do anything else with the snapshot objects
    When the supervisor requests "<action>" on the object "tenants/anthus/computers/computer-1/manifest.json" of bucket "snapshots"
    Then the supervisor role denies the request

    Examples:
      | action                         |
      | s3:DeleteObject                |
      | s3:DeleteObjectVersion         |
      | s3:GetObjectVersion            |
      | s3:PutObjectAcl                |
      | s3:ListBucketMultipartUploads  |
      | s3:*                           |

  Scenario Outline: The supervisor reads the edit overlay of its own computer and cannot write, delete or replace it
    When the supervisor requests "<action>" on the object "<key>" of bucket "snapshots"
    Then the supervisor role <verdict> the request

    Examples:
      | action                  | key                                                    | verdict |
      | s3:GetObject            | tenants/anthus/computers/computer-1/overlay/index.json | allows  |
      | s3:GetObject            | tenants/anthus/computers/computer-1/overlay/blobs/abc  | allows  |
      | s3:PutObject            | tenants/anthus/computers/computer-1/overlay/index.json | denies  |
      | s3:PutObject            | tenants/anthus/computers/computer-1/overlay/blobs/abc  | denies  |
      | s3:DeleteObject         | tenants/anthus/computers/computer-1/overlay/index.json | denies  |
      | s3:DeleteObject         | tenants/anthus/computers/computer-1/overlay/blobs/abc  | denies  |
      | s3:DeleteObjectVersion  | tenants/anthus/computers/computer-1/overlay/index.json | denies  |
      | s3:PutObjectTagging     | tenants/anthus/computers/computer-1/overlay/blobs/abc  | denies  |
      | s3:AbortMultipartUpload | tenants/anthus/computers/computer-1/overlay/blobs/abc  | denies  |
      | s3:PutObject            | tenants/anthus/computers/computer-1/snapshot.tar.gz    | allows  |
      | s3:PutObject            | tenants/anthus/computers/computer-1/manifest.json      | allows  |
      | s3:AbortMultipartUpload | tenants/anthus/computers/computer-1/snapshot.tar.gz    | allows  |
      | s3:PutObject            | tenants/anthus/computers/computer-1/overlayish/file    | allows  |
      | s3:PutObject            | tenants/anthus/computers/computer-2/overlay/index.json | denies  |

  Scenario Outline: The supervisor cannot list the snapshot bucket
    When the supervisor lists bucket "snapshots" with the prefix "<prefix>"
    Then the supervisor role denies the request

    Examples:
      | prefix                                |
      | tenants/anthus/computers/computer-1/  |
      | tenants/anthus/                       |
      |                                       |

  Scenario Outline: The supervisor cannot reach a conversation session, the transcript or the organization record
    When the supervisor requests "<action>" on the "<table>" table for the keys "<key>"
    Then the supervisor role denies the request

    Examples:
      | action                      | table         | key                       |
      | dynamodb:GetItem            | messaging     | anthus#org                |
      | dynamodb:GetItem            | messaging     | anthus#computer#record    |
      | dynamodb:UpdateItem         | messaging     | anthus#computer#record    |
      | dynamodb:PutItem            | messaging     | anthus#turn#0000000004    |
      | dynamodb:Query              | messaging     | MB#anthus#bot-1#channel-1 |
      | dynamodb:GetItem            | messaging     | anthus#roster             |
      | dynamodb:GetItem            | conversations | PI#anthus#bot-1#channel-1 |
      | dynamodb:PutItem            | conversations | PI#anthus#bot-1#channel-1 |
      | dynamodb:ConditionCheckItem | conversations | PI#anthus#bot-1#channel-1 |

  Scenario Outline: The supervisor takes no table action that carries no key
    When the supervisor requests "<action>" on the "<table>" table with no key
    Then the supervisor role denies the request

    Examples:
      | action                  | table         |
      | dynamodb:Scan           | messaging     |
      | dynamodb:Scan           | conversations |
      | dynamodb:BatchWriteItem | messaging     |
      | dynamodb:BatchGetItem   | conversations |
      | dynamodb:DescribeTable  | messaging     |

  Scenario Outline: The supervisor cannot reach the Pi sessions bucket or any other bucket
    When the supervisor requests "<action>" on the object "<key>" of bucket "<bucket>"
    Then the supervisor role denies the request

    Examples:
      | action          | bucket       | key                                                       |
      | s3:GetObject    | pi-sessions  | conversations/anthus%23bot-1%23channel-1/commits/1.json   |
      | s3:PutObject    | pi-sessions  | conversations/anthus%23bot-1%23channel-1/commits/1.json   |
      | s3:DeleteObject | pi-sessions  | conversations/anthus%23bot-1%23channel-1/commits/1.json   |
      | s3:GetObject    | other-bucket | tenants/anthus/computers/computer-1/manifest.json         |

  Scenario Outline: The supervisor takes no action outside S3 and DynamoDB
    When the supervisor requests "<action>" on the resource "<resource>"
    Then the supervisor role denies the request

    Examples:
      | action                         | resource                                                           |
      | secretsmanager:GetSecretValue  | arn:aws:secretsmanager:us-east-1:111111111111:secret:signing-key   |
      | ssm:GetParameter               | arn:aws:ssm:us-east-1:111111111111:parameter/chatticus/anything    |
      | ssm:GetParameter               | arn:aws:ssm:us-east-1:111111111111:parameter/chatticus/development/model-gateway/signing-key |
      | ssm:GetParameterHistory        | arn:aws:ssm:us-east-1:111111111111:parameter/chatticus/development/model-gateway/signing-key |
      | ssm:GetParameter               | arn:aws:ssm:us-east-1:111111111111:parameter/chatticus/development/thin-turn/operator-key    |
      | ssm:GetParameterHistory        | arn:aws:ssm:us-east-1:111111111111:parameter/chatticus/development/thin-turn/operator-key    |
      | sts:AssumeRole                 | arn:aws:iam::111111111111:role/ComputerOwnerScopedRole             |
      | sqs:SendMessage                | arn:aws:sqs:us-east-1:111111111111:turn-jobs                       |
      | ecs:StopTask                   | arn:aws:ecs:us-east-1:111111111111:task/cluster/task-1             |

  Scenario: The policy file the stack deploys names one allow over the computer prefix and one deny over its overlay
    Then the supervisor role has exactly two statements
    And the supervisor role allow statement allows only get, put and abort of multipart upload
    And the supervisor role deny statement denies put, delete, delete of a version, tagging and abort of multipart upload on the overlay prefix built from both session tags
    And every resource of the supervisor role statements is a snapshot object path built from both session tags
    And the supervisor role statements hold no condition and no wildcard action
