import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "node:test";
import { PI_SESSION_TABLE_KEYS } from "../../conversation/src/storage/table-definition.ts";
import {
  CONVERSATIONS_TABLE_LOCAL_SECONDARY_INDEXES,
  ControlPlaneStack,
} from "../lib/control-plane-stack";
import { CHATTICUS_CLOUD_ENVIRONMENTS, ChatticusCloudEnvironment } from "../lib/environments";

function synthControlPlane(environmentName: ChatticusCloudEnvironment): Template {
  const app = new cdk.App();
  const support = new cdk.Stack(app, "Support", {
    env: { account: "111111111111", region: "us-east-1" },
  });
  const messagingTable = new dynamodb.Table(support, "Messaging", {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  });
  const stack = new ControlPlaneStack(app, "ControlPlane", {
    env: { account: "111111111111", region: "us-east-1" },
    chatticusEnvironment: environmentName,
    messagingTable,
  });
  return Template.fromStack(stack);
}

function functionByDescription(template: Template, fragment: string): Record<string, any> {
  const matches = Object.values(template.findResources("AWS::Lambda::Function")).filter(
    (resource) => String(resource.Properties.Description ?? "").includes(fragment),
  );
  assert.equal(matches.length, 1, `exactly one function described by ${fragment}`);
  return matches[0].Properties;
}

describe("ControlPlaneStack", () => {
  const development = synthControlPlane("development");

  it("keeps the local secondary indexes identical to the Pi table definition", () => {
    const expected = PI_SESSION_TABLE_KEYS.localSecondaryIndexes.map((index) => ({
      indexName: index.indexName,
      attributeName: index.attributeName,
    }));
    assert.deepEqual(
      CONVERSATIONS_TABLE_LOCAL_SECONDARY_INDEXES.map((index) => ({ ...index })),
      expected,
    );
  });

  it("creates the Conversations table pay per request with three local secondary indexes", () => {
    development.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      LocalSecondaryIndexes: PI_SESSION_TABLE_KEYS.localSecondaryIndexes.map((index) =>
        Match.objectLike({
          IndexName: index.indexName,
          Projection: { ProjectionType: "ALL" },
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: index.attributeName, KeyType: "RANGE" },
          ],
        }),
      ),
    });
  });

  it("retains data outside development and destroys it in development", () => {
    const tableDeletion = (template: Template): string =>
      Object.values(template.findResources("AWS::DynamoDB::Table"))[0].DeletionPolicy;
    assert.equal(tableDeletion(development), "Delete");
    for (const environmentName of CHATTICUS_CLOUD_ENVIRONMENTS.filter((name) => name !== "development")) {
      const template = synthControlPlane(environmentName);
      assert.equal(tableDeletion(template), "Retain");
      const bucket = Object.values(template.findResources("AWS::S3::Bucket"))[0];
      assert.equal(bucket.DeletionPolicy, "Retain");
    }
  });

  it("blocks public access, enforces SSL and never expires session objects", () => {
    development.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    development.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
    const bucket = Object.values(development.findResources("AWS::S3::Bucket"))[0];
    assert.equal(bucket.Properties.LifecycleConfiguration, undefined);
    assert.equal(bucket.Properties.VersioningConfiguration, undefined);
  });

  it("creates three queues, each with a dead-letter queue", () => {
    const queues = Object.values(development.findResources("AWS::SQS::Queue"));
    assert.equal(queues.length, 6);
    const withDeadLetter = queues.filter((queue) => queue.Properties.RedrivePolicy !== undefined);
    assert.equal(withDeadLetter.length, 3);
    const visibilityTimeouts = withDeadLetter
      .map((queue) => queue.Properties.VisibilityTimeout)
      .sort((left, right) => left - right);
    assert.deepEqual(visibilityTimeouts, [360, 360, 1800]);
  });

  it("sizes each Lambda as designed on Node 22 arm64", () => {
    const expected: [string, number, number][] = [
      ["TypeScript front door", 512, 900],
      ["TurnRuns consumer", 1024, 300],
      ["TurnProbes consumer", 256, 60],
      ["ComputerStartJobs consumer", 256, 60],
    ];
    for (const [fragment, memorySize, timeout] of expected) {
      const properties = functionByDescription(development, fragment);
      assert.equal(properties.Runtime, "nodejs22.x");
      assert.deepEqual(properties.Architectures, ["arm64"]);
      assert.equal(properties.MemorySize, memorySize);
      assert.equal(properties.Timeout, timeout);
    }
  });

  it("gives the FrontDoor its own streaming Function URL and routes nothing to CloudFront", () => {
    development.resourceCountIs("AWS::Lambda::Url", 1);
    development.hasResourceProperties("AWS::Lambda::Url", {
      InvokeMode: "RESPONSE_STREAM",
      AuthType: "NONE",
    });
    development.resourceCountIs("AWS::CloudFront::Distribution", 0);
  });

  it("tells the executor, probe and starter where the queues, tables and environment are", () => {
    for (const fragment of ["TurnRuns consumer", "TurnProbes consumer", "ComputerStartJobs consumer"]) {
      const variables = functionByDescription(development, fragment).Environment.Variables;
      for (const name of [
        "CHATTICUS_COMPUTER_STARTS_QUEUE_URL",
        "CHATTICUS_TURN_RUNS_QUEUE_URL",
        "CHATTICUS_TURN_PROBES_QUEUE_URL",
        "CHATTICUS_MESSAGING_TABLE",
        "CHATTICUS_CONVERSATIONS_TABLE",
        "CHATTICUS_PI_SESSIONS_BUCKET",
      ]) {
        assert.ok(variables[name] !== undefined, `${fragment} sets ${name}`);
      }
      assert.equal(variables.CHATTICUS_ENVIRONMENT, "development");
    }
  });

  it("lets only the FrontDoor and the executor read the OpenAI key parameter", () => {
    const parameterName = "/chatticus/development/thin-turn/openai-api-key";
    for (const fragment of ["TypeScript front door", "TurnRuns consumer"]) {
      const variables = functionByDescription(development, fragment).Environment.Variables;
      assert.equal(variables.OPENAI_API_KEY_PARAMETER, parameterName);
    }
    for (const fragment of ["TurnProbes consumer", "ComputerStartJobs consumer"]) {
      const variables = functionByDescription(development, fragment).Environment.Variables;
      assert.equal(variables.OPENAI_API_KEY_PARAMETER, undefined);
    }
    const policies = Object.values(development.findResources("AWS::IAM::Policy"));
    const readers = policies.filter((policy) =>
      JSON.stringify(policy.Properties.PolicyDocument).includes(`parameter${parameterName}`),
    );
    assert.equal(readers.length, 2);
  });

  it("consumes each queue with batch size 1 and reports start failures per item", () => {
    const mappings = Object.values(development.findResources("AWS::Lambda::EventSourceMapping"));
    assert.equal(mappings.length, 3);
    for (const mapping of mappings) {
      assert.equal(mapping.Properties.BatchSize, 1);
    }
    assert.equal(
      mappings.filter((mapping) => mapping.Properties.FunctionResponseTypes !== undefined).length,
      1,
    );
  });

  it("creates no IAM users or EventBridge schedules", () => {
    development.resourceCountIs("AWS::IAM::User", 0);
    development.resourceCountIs("AWS::Scheduler::Schedule", 0);
    development.resourceCountIs("AWS::Scheduler::ScheduleGroup", 0);
  });
});
