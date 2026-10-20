import * as cdk from "aws-cdk-lib";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

/** Name of the one audit trail of the account. */
export const AUDIT_TRAIL_NAME = "chatticus-audit-trail";

/** Days a delivered log file is kept before the bucket expires it. */
export const AUDIT_TRAIL_RETENTION_DAYS = 400;

/**
 * Account-level audit trail: one multi-region trail that records management
 * events only (reads and writes, global services included) into a private
 * S3-managed-encryption bucket.
 *
 * The first copy of management events delivered to S3 is free, so this costs
 * only the storage and requests of the log files. It deliberately records no
 * data events, no Insights, and has no CloudWatch Logs integration and no KMS
 * key, because each of those is billed per event or per key. One account holds
 * development, staging and production, so this stack exists once, owned by
 * production. Deploy it only with
 * `sh deploy-chatticus-dedicated-account.sh production audit-trail`.
 */
export class AuditTrailStack extends cdk.Stack {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, "AuditTrailLogs", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(AUDIT_TRAIL_RETENTION_DAYS),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    const trailArn = this.formatArn({
      service: "cloudtrail",
      resource: "trail",
      resourceName: AUDIT_TRAIL_NAME,
    });
    const cloudTrailPrincipal = new iam.ServicePrincipal("cloudtrail.amazonaws.com");
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudTrailAclCheck",
        principals: [cloudTrailPrincipal],
        actions: ["s3:GetBucketAcl"],
        resources: [this.bucket.bucketArn],
        conditions: { StringEquals: { "aws:SourceArn": trailArn } },
      }),
    );
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudTrailWrite",
        principals: [cloudTrailPrincipal],
        actions: ["s3:PutObject"],
        resources: [this.bucket.arnForObjects(`AWSLogs/${this.account}/*`)],
        conditions: {
          StringEquals: {
            "aws:SourceArn": trailArn,
            "s3:x-amz-acl": "bucket-owner-full-control",
          },
        },
      }),
    );

    const trail = new cloudtrail.CfnTrail(this, "AuditTrail", {
      trailName: AUDIT_TRAIL_NAME,
      s3BucketName: this.bucket.bucketName,
      isLogging: true,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableLogFileValidation: true,
      eventSelectors: [{ includeManagementEvents: true, readWriteType: "All" }],
    });
    trail.node.addDependency(this.bucket.policy!);

    new cdk.CfnOutput(this, "AuditTrailBucketName", {
      value: this.bucket.bucketName,
      description:
        "S3 bucket holding the CloudTrail management-event logs under AWSLogs/. Kept 400 days.",
    });
    new cdk.CfnOutput(this, "AuditTrailName", {
      value: AUDIT_TRAIL_NAME,
      description: "Multi-region management-event trail of this account.",
    });
  }
}
