import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { BudgetsConfig } from "./budgets-config";
import { ChatticusBudgets } from "./chatticus-budgets";

export interface SnapshotStackProps extends cdk.StackProps {
  readonly budgetsConfig?: BudgetsConfig;
}

/**
 * Canonical object store for computer workplace snapshots.
 *
 * Hosts publish and hydrate packs here. Do not create this bucket with the
 * AWS CLI or the console.
 */
export class SnapshotStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: SnapshotStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, "ComputerSnapshots", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });
    this.bucket.addLifecycleRule({
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
    });

    const localWorkerRole = new iam.Role(this, "LocalWorkerRole", {
      assumedBy: new iam.AccountRootPrincipal(),
      description:
        "Garage Mac and other local hosts: publish and hydrate computer snapshots.",
    });
    this.bucket.grantReadWrite(localWorkerRole);

    if (props?.budgetsConfig) {
      const budgets = new ChatticusBudgets(this, "Budgets", {
        monthlyLimitUsd: props.budgetsConfig.monthlyLimitUsd,
        notificationEmails: props.budgetsConfig.notificationEmails,
      });
      new cdk.CfnOutput(this, "BudgetsAlertsTopicArn", {
        value: budgets.alertsTopic.topicArn,
        description: "SNS topic for account-level AWS spend budget alerts.",
      });
      new cdk.CfnOutput(this, "BudgetsMonthlyLimitUsd", {
        value: String(props.budgetsConfig.monthlyLimitUsd),
        description: "Configured monthly AWS spend budget limit (USD).",
      });
    }

    new cdk.CfnOutput(this, "SnapshotBucketName", {
      value: this.bucket.bucketName,
      description:
        "Set CHATTICUS_SNAPSHOT_BUCKET to this value. Snapshot URIs use s3://this-name/...",
    });
    new cdk.CfnOutput(this, "SnapshotBucketArn", {
      value: this.bucket.bucketArn,
    });
    new cdk.CfnOutput(this, "LocalWorkerRoleArn", {
      value: localWorkerRole.roleArn,
      description:
        "Local hosts may assume this role to read and write snapshot packs.",
    });
  }
}
