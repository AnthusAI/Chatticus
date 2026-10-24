import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AuditTrailStack, AUDIT_TRAIL_RETENTION_DAYS } from "../lib/audit-trail-stack";
import { buildDedicatedAccountStacks } from "../lib/dedicated-account-stacks";
import { CHATTICUS_CLOUD_ENVIRONMENTS } from "../lib/environments";
import { stubWebsiteDeploySource } from "../lib/web-bundle-stub";

const testEnv = { account: "111111111111", region: "us-east-1" };

function synthAuditTrail(): Template {
  const app = new cdk.App();
  const stack = new AuditTrailStack(app, "ChatticusAuditTrail", { env: testEnv });
  return Template.fromStack(stack);
}

describe("ChatticusAuditTrail", () => {
  const template = synthAuditTrail();

  it("creates exactly one trail and one bucket", () => {
    template.resourceCountIs("AWS::CloudTrail::Trail", 1);
    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.resourceCountIs("AWS::S3::BucketPolicy", 1);
  });

  it("records management events of every region, global services included, and is logging", () => {
    template.hasResourceProperties("AWS::CloudTrail::Trail", {
      IsLogging: true,
      IsMultiRegionTrail: true,
      IncludeGlobalServiceEvents: true,
      EnableLogFileValidation: true,
      EventSelectors: [{ IncludeManagementEvents: true, ReadWriteType: "All" }],
    });
  });

  it("records no data events and no insights", () => {
    const trail = Object.values(template.findResources("AWS::CloudTrail::Trail"))[0];
    const properties = trail.Properties as Record<string, unknown>;
    assert.equal(JSON.stringify(properties).includes("DataResources"), false);
    assert.equal(properties.AdvancedEventSelectors, undefined);
    assert.equal(properties.InsightSelectors, undefined);
  });

  it("uses no KMS key and no CloudWatch Logs integration", () => {
    template.resourceCountIs("AWS::KMS::Key", 0);
    template.resourceCountIs("AWS::Logs::LogGroup", 0);
    template.resourceCountIs("AWS::IAM::Role", 0);
    const trail = Object.values(template.findResources("AWS::CloudTrail::Trail"))[0];
    const properties = trail.Properties as Record<string, unknown>;
    assert.equal(properties.KMSKeyId, undefined);
    assert.equal(properties.CloudWatchLogsLogGroupArn, undefined);
    assert.equal(properties.CloudWatchLogsRoleArn, undefined);
  });

  it("stores logs in a private SSE-S3 bucket that is not versioned and is retained", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
    });
    const bucket = Object.values(template.findResources("AWS::S3::Bucket"))[0];
    assert.equal((bucket.Properties as Record<string, unknown>).VersioningConfiguration, undefined);
    assert.equal(bucket.DeletionPolicy, "Retain");
    assert.equal(bucket.UpdateReplacePolicy, "Retain");
    const trail = Object.values(template.findResources("AWS::CloudTrail::Trail"))[0];
    assert.equal(trail.DeletionPolicy, undefined);
  });

  it("expires logs after 400 days and aborts incomplete multipart uploads", () => {
    assert.equal(AUDIT_TRAIL_RETENTION_DAYS, 400);
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: "Enabled",
            ExpirationInDays: 400,
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }),
        ]),
      },
    });
  });

  it("lets only the CloudTrail service write, scoped to this trail by source arn, and enforces TLS", () => {
    const policy = Object.values(template.findResources("AWS::S3::BucketPolicy"))[0];
    const statements = (policy.Properties as { PolicyDocument: { Statement: Array<Record<string, any>> } }).PolicyDocument.Statement;
    const serviceStatements = statements.filter((statement) => statement.Principal?.Service === "cloudtrail.amazonaws.com");
    assert.equal(serviceStatements.length, 2);
    assert.deepEqual(
      serviceStatements.map((statement) => statement.Action).sort(),
      ["s3:GetBucketAcl", "s3:PutObject"],
    );
    for (const statement of serviceStatements) {
      assert.equal(statement.Effect, "Allow");
      const sourceArn = JSON.stringify(statement.Condition?.StringEquals?.["aws:SourceArn"]);
      assert.match(sourceArn, /:trail\/chatticus-audit-trail/);
    }
    const write = serviceStatements.find((statement) => statement.Action === "s3:PutObject")!;
    assert.equal(write.Condition.StringEquals["s3:x-amz-acl"], "bucket-owner-full-control");
    assert.match(JSON.stringify(write.Resource), /AWSLogs/);
    const tls = statements.find((statement) => statement.Effect === "Deny" && statement.Condition?.Bool?.["aws:SecureTransport"] === "false");
    assert.ok(tls, "TLS enforcement statement");
    const others = statements.filter((statement) => statement.Principal?.Service !== "cloudtrail.amazonaws.com" && statement !== tls);
    assert.deepEqual(others, []);
  });

  it("names nothing but the trail, so it cannot collide with another resource", () => {
    const bucket = Object.values(template.findResources("AWS::S3::Bucket"))[0];
    assert.equal((bucket.Properties as Record<string, unknown>).BucketName, undefined);
    template.hasResourceProperties("AWS::CloudTrail::Trail", { TrailName: "chatticus-audit-trail" });
  });
});

describe("the audit trail belongs to the production environment's stack set", () => {
  function stackNamesOf(environment: (typeof CHATTICUS_CLOUD_ENVIRONMENTS)[number]): string[] {
    const app = new cdk.App();
    buildDedicatedAccountStacks(app, {
      env: testEnv,
      environmentName: environment,
      websiteDeploySource: stubWebsiteDeploySource,
    });
    return app.node.children.filter(cdk.Stack.isStack).map((stack) => stack.node.id);
  }

  it("is built for production only", () => {
    assert.ok(stackNamesOf("production").includes("ChatticusAuditTrail"));
    assert.equal(stackNamesOf("development").includes("ChatticusAuditTrail"), false);
    assert.equal(stackNamesOf("staging").includes("ChatticusAuditTrail"), false);
  });
});
