Feature: Customer organization snapshot bucket
  As a customer organization
  I want my snapshot packs stored in my own AWS account
  So that workplace files never land in Anthus-managed storage

  Background:
    Given the published customer cross-account CloudFormation template

  Scenario: The published template declares a retained organization snapshot bucket
    Then the template declares an organization snapshot bucket in the customer account
    And the bucket uses server-side encryption and blocks public access
    And the bucket has versioning enabled
    And the bucket deletion policy is Retain
    And the template exports SnapshotBucketName

  Scenario: The cross-account role cannot create buckets or reach Anthus snapshot storage
    Then the cross-account role policy does not grant s3:CreateBucket
    And the cross-account role policy does not grant s3 on Anthus-managed snapshot buckets
    And the cross-account role policy does not grant s3:*

  Scenario: The customer computer task role can read and write the organization bucket only
    Given the committed customer ChatticusComputers CloudFormation template
    And organization snapshot bucket name "chatticus-snapshots-a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    Then the computer task role grants s3:GetObject and s3:PutObject on that bucket
    And the computer task role does not grant s3:CreateBucket
    And the computer task role does not grant s3:ListBucket

  Scenario: The customer computer container receives the snapshot bucket from the customer stack
    Given the committed customer ChatticusComputers CloudFormation template
    Then the computer container environment includes CHATTICUS_SNAPSHOT_BUCKET from the snapshot bucket parameter
    And the container environment does not hardcode an Anthus snapshot bucket name

  Scenario: CreateStack passes the organization snapshot bucket name
    Given an empty organization records store
    And an organization provisioned into a customer AWS account without a ChatticusComputers stack
    When its computer is asked to start
    Then Chatticus creates the ChatticusComputers stack in the customer account
    And CreateStack parameters include SnapshotBucketName for the organization
