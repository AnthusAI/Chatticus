Feature: The Front Door role sees a missing snapshot object as absent and not as forbidden
  As the operator of the control plane
  I want the Front Door role to read, overlay and list the snapshot bucket in the way S3 needs
  So that reading an overlay that was never written answers not found and the Files panel keeps working

  The Front Door Lambda reads computer snapshots and writes the edit overlay of
  a computer. S3 answers a read of a key that does not exist with 404 NoSuchKey
  only when the caller may list the bucket, and that list permission is checked
  without an s3:prefix key, so a list permission restricted by prefix does not
  count. Without it the same read answers 403 AccessDenied, which the Front Door
  reports as an unavailable overlay. These scenarios take the statements of the
  file the CDK stack deploys and ask what S3 would answer.

  Background:
    Given the Front Door role of the snapshot bucket

  Scenario Outline: The Front Door reads a missing object as not found and an existing one as returned
    When the Front Door reads the key "<key>" which "<existence>"
    Then S3 answers "<answer>"

    Examples:
      | key                                                    | existence   | answer     |
      | tenants/anthus/computers/computer-1/overlay/index.json | exists      | returned   |
      | tenants/anthus/computers/computer-1/overlay/index.json | is missing  | NoSuchKey  |
      | tenants/anthus/computers/computer-1/manifest.json      | is missing  | NoSuchKey  |
      | tenants/other/computers/computer-9/snapshot.tar.gz     | is missing  | NoSuchKey  |

  Scenario Outline: The Front Door reads only computer objects
    When the Front Door reads the key "<key>" which "<existence>"
    Then S3 answers "<answer>"

    Examples:
      | key                                   | existence | answer       |
      | tenants/anthus/manifest.json          | exists    | AccessDenied |
      | other/anthus/computers/c/manifest.json | exists    | AccessDenied |

  Scenario Outline: The Front Door writes and deletes only under the overlay of a computer
    When the Front Door requests "<action>" on the key "<key>"
    Then the Front Door role <verdict> the request

    Examples:
      | action          | key                                                    | verdict |
      | s3:PutObject    | tenants/anthus/computers/computer-1/overlay/index.json | allows  |
      | s3:DeleteObject | tenants/anthus/computers/computer-1/overlay/blobs/abc  | allows  |
      | s3:PutObject    | tenants/anthus/computers/computer-1/snapshot.tar.gz    | denies  |
      | s3:DeleteObject | tenants/anthus/computers/computer-1/manifest.json      | denies  |
      | s3:DeleteObjectVersion | tenants/anthus/computers/computer-1/overlay/index.json | denies |
      | s3:PutObjectTagging | tenants/anthus/computers/computer-1/overlay/index.json | denies |

  Scenario: The Front Door role holds no condition on listing and no statement beyond read, overlay write and list
    Then the Front Door role has exactly the statements "ReadComputerSnapshots, WriteComputerEditOverlay, ListComputerSnapshots"
    And the Front Door role lists the bucket with no condition
