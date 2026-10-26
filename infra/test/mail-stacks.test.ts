import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AccountGitHubDeployStack } from "../lib/account-github-deploy-stack";
import { buildDedicatedAccountStacks } from "../lib/dedicated-account-stacks";
import {
  CHATTICUS_CLOUD_ENVIRONMENTS,
  ENVIRONMENT_ZONES_STACK_IDS,
  MAIL_DOMAINS,
  MAIL_ENVIRONMENTS,
  MAIL_INGRESS_STACK_ID,
  MAIL_RAW_RETENTION_DAYS,
  MAIL_RECEIPT_RULE_SET_NAME,
  MAIL_STACK_IDS,
  type ChatticusCloudEnvironment,
} from "../lib/environments";
import { stubWebsiteDeploySource } from "../lib/web-bundle-stub";

const ENV = { account: "444444444444", region: "us-east-1" };

function build(environmentName: ChatticusCloudEnvironment): cdk.App {
  const app = new cdk.App();
  buildDedicatedAccountStacks(app, {
    env: ENV,
    environmentName,
    websiteDeploySource: stubWebsiteDeploySource,
  });
  return app;
}

function stackIds(app: cdk.App): string[] {
  return app.node.children.filter(cdk.Stack.isStack).map((stack) => stack.node.id);
}

function stackOf(app: cdk.App, id: string): cdk.Stack {
  return app.node.findChild(id) as cdk.Stack;
}

const developmentApp = build("development");
const ingress = Template.fromStack(stackOf(developmentApp, MAIL_INGRESS_STACK_ID));
const mail = Template.fromStack(stackOf(developmentApp, MAIL_STACK_IDS.development));
const mailDomain = MAIL_DOMAINS.development;

describe("the mail rollout switch", () => {
  it("builds mail for development only", () => {
    assert.deepEqual([...MAIL_ENVIRONMENTS], ["development"]);
  });

  it("builds the shared ingress stack and the development mail stack in the development build", () => {
    const ids = stackIds(developmentApp);
    assert.ok(ids.includes(MAIL_INGRESS_STACK_ID));
    assert.ok(ids.includes(MAIL_STACK_IDS.development));
  });

  for (const environment of CHATTICUS_CLOUD_ENVIRONMENTS.filter((name) => name !== "development")) {
    it(`builds no mail stack and no shared ingress stack for ${environment}`, () => {
      const ids = stackIds(build(environment));
      assert.equal(ids.includes(MAIL_INGRESS_STACK_ID), false);
      assert.equal(ids.includes(MAIL_STACK_IDS[environment]), false);
    });
  }

  it("names the production mail domain mail.chattic.us and the others below their own site names", () => {
    assert.deepEqual(MAIL_DOMAINS, {
      development: "mail.develop.chattic.us",
      staging: "mail.staging.chattic.us",
      production: "mail.chattic.us",
    });
  });
});

describe("the shared mail ingress stack", () => {
  it("owns the account's one receipt rule set under a fixed name", () => {
    ingress.resourceCountIs("AWS::SES::ReceiptRuleSet", 1);
    ingress.hasResourceProperties("AWS::SES::ReceiptRuleSet", { RuleSetName: MAIL_RECEIPT_RULE_SET_NAME });
  });

  it("holds no receipt rule, so no environment's rule can be edited from it", () => {
    ingress.resourceCountIs("AWS::SES::ReceiptRule", 0);
  });

  it("activates the rule set through a custom resource and deactivates it again on delete", () => {
    const resources = Object.values(ingress.findResources("Custom::AWS")) as Array<{ Properties: Record<string, unknown> }>;
    assert.equal(resources.length, 1);
    const properties = resources[0].Properties;
    for (const phase of ["Create", "Update"]) {
      const text = JSON.stringify(properties[phase]);
      assert.ok(text.includes('\\"service\\":\\"SES\\"'));
      assert.ok(text.includes('\\"action\\":\\"setActiveReceiptRuleSet\\"'));
      assert.ok(text.includes("RuleSetName"));
      assert.ok(text.includes('"Ref":"ReceiptRuleSet"'));
    }
    const removal = JSON.parse(properties.Delete as string) as { service: string; action: string; parameters?: Record<string, string> };
    assert.equal(removal.service, "SES");
    assert.equal(removal.action, "setActiveReceiptRuleSet");
    assert.deepEqual(removal.parameters ?? {}, {});
  });

  it("deletes the activation before the rule set, so an active rule set is never deleted", () => {
    const customResourceId = Object.keys(ingress.findResources("Custom::AWS"))[0];
    const ruleSet = Object.values(ingress.findResources("AWS::SES::ReceiptRuleSet"))[0] as { Properties: unknown };
    assert.ok(ruleSet);
    const dependsOn = (ingress.findResources("Custom::AWS")[customResourceId] as { DependsOn?: string[] }).DependsOn ?? [];
    const ruleSetId = Object.keys(ingress.findResources("AWS::SES::ReceiptRuleSet"))[0];
    assert.ok(dependsOn.includes(ruleSetId));
  });

  it("lets the activation call only SetActiveReceiptRuleSet in SES", () => {
    const sesStatements = Object.values(ingress.findResources("AWS::IAM::Policy")).flatMap(
      (policy) =>
        (policy as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } }).Properties
          .PolicyDocument.Statement,
    );
    const actions = sesStatements.flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]));
    assert.ok(actions.includes("ses:SetActiveReceiptRuleSet"));
    assert.deepEqual(
      actions.filter((action) => action.startsWith("ses:")),
      ["ses:SetActiveReceiptRuleSet"],
    );
  });

  it("is protected from termination and does not install the latest SDK at run time", () => {
    assert.equal(stackOf(developmentApp, MAIL_INGRESS_STACK_ID).terminationProtection, true);
    const text = JSON.stringify(ingress.toJSON());
    assert.doesNotMatch(text, /npm install|installLatestAwsSdk/);
  });
});

describe("the development mail stack: domain and DNS", () => {
  it("creates a retained public hosted zone for the mail domain and protects the stack", () => {
    mail.resourceCountIs("AWS::Route53::HostedZone", 1);
    mail.hasResourceProperties("AWS::Route53::HostedZone", { Name: `${mailDomain}.` });
    for (const zone of Object.values(mail.findResources("AWS::Route53::HostedZone"))) {
      assert.equal((zone as { DeletionPolicy?: string }).DeletionPolicy, "Retain");
    }
    assert.equal(stackOf(developmentApp, MAIL_STACK_IDS.development).terminationProtection, true);
  });

  it("delegates the mail zone with one NS record inside the environment's own site zone", () => {
    mail.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: `${mailDomain}.`,
      Type: "NS",
      HostedZoneId: Match.anyValue(),
      ResourceRecords: Match.anyValue(),
    });
    const nsRecords = Object.values(mail.findResources("AWS::Route53::RecordSet")).filter(
      (record) => (record as { Properties: { Type: string } }).Properties.Type === "NS",
    );
    assert.equal(nsRecords.length, 1);
    const parentZoneReference = JSON.stringify(
      (Object.values(mail.findResources("AWS::Route53::RecordSet")).find(
        (record) => (record as { Properties: { Type: string } }).Properties.Type === "NS",
      ) as { Properties: { HostedZoneId: unknown } }).Properties.HostedZoneId,
    );
    assert.ok(parentZoneReference.includes(ENVIRONMENT_ZONES_STACK_IDS.development));
  });

  it("creates an SES domain identity with Easy DKIM and a custom MAIL FROM subdomain", () => {
    mail.resourceCountIs("AWS::SES::EmailIdentity", 1);
    mail.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: mailDomain,
      DkimAttributes: { SigningEnabled: true },
      MailFromAttributes: { MailFromDomain: `bounce.${mailDomain}`, BehaviorOnMxFailure: "REJECT_MESSAGE" },
    });
  });

  it("publishes the three DKIM CNAMEs, the MAIL FROM MX and SPF records, and a DMARC record at p=none", () => {
    const recordSets = Object.values(mail.findResources("AWS::Route53::RecordSet")) as Array<{
      Properties: { Type: string; Name: string | object; ResourceRecords?: unknown };
    }>;
    assert.equal(recordSets.filter((record) => record.Properties.Type === "CNAME").length, 3);
    mail.hasResourceProperties("AWS::Route53::RecordSet", { Type: "MX", Name: `bounce.${mailDomain}.` });
    mail.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "TXT",
      Name: `bounce.${mailDomain}.`,
      ResourceRecords: ['"v=spf1 include:amazonses.com ~all"'],
    });
    mail.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "TXT",
      Name: `_dmarc.${mailDomain}.`,
      ResourceRecords: ['"v=DMARC1; p=none; adkim=s; aspf=s"'],
    });
  });

  it("points the bare mail name and every name below it at the SES inbound endpoint", () => {
    for (const name of [`${mailDomain}.`, `*.${mailDomain}.`]) {
      mail.hasResourceProperties("AWS::Route53::RecordSet", {
        Type: "MX",
        Name: name,
        ResourceRecords: ["10 inbound-smtp.us-east-1.amazonaws.com"],
      });
    }
  });
});

describe("the development mail stack: inbound receiving", () => {
  it("adds exactly one receipt rule, for this environment's domain only, to the shared rule set", () => {
    mail.resourceCountIs("AWS::SES::ReceiptRule", 1);
    mail.hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: Match.objectLike({
        Name: "chatticus-development-mail",
        Enabled: true,
        Recipients: [mailDomain],
        ScanEnabled: true,
      }),
    });
    const [rule] = Object.values(mail.findResources("AWS::SES::ReceiptRule")) as Array<{
      Properties: { RuleSetName: unknown };
    }>;
    assert.ok(JSON.stringify(rule.Properties.RuleSetName).includes("Fn::ImportValue"));
  });

  it("stores raw mail in S3 only; the Lambda action belongs to the ingress Lambda task", () => {
    const [rule] = Object.values(mail.findResources("AWS::SES::ReceiptRule")) as Array<{
      Properties: { Rule: { Actions: Array<Record<string, unknown>> } };
    }>;
    assert.equal(rule.Properties.Rule.Actions.length, 1);
    assert.ok("S3Action" in rule.Properties.Rule.Actions[0]);
    assert.equal(JSON.stringify(rule).includes("LambdaAction"), false);
    mail.hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: Match.objectLike({ Actions: [{ S3Action: Match.objectLike({ ObjectKeyPrefix: "raw/" }) }] }),
    });
  });

  it("keeps raw mail in one private, encrypted, TLS-only bucket that expires objects after thirty days", () => {
    mail.resourceCountIs("AWS::S3::Bucket", 1);
    assert.equal(MAIL_RAW_RETENTION_DAYS, 30);
    mail.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ Status: "Enabled", ExpirationInDays: 30 })],
      },
    });
    for (const bucket of Object.values(mail.findResources("AWS::S3::Bucket"))) {
      assert.equal((bucket as { DeletionPolicy?: string }).DeletionPolicy, "Retain");
      assert.equal(JSON.stringify(bucket).includes("VersioningConfiguration"), false);
    }
    mail.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      },
    });
  });

  it("lets only SES, for this account and this one receipt rule, put objects under the raw prefix", () => {
    const policies = Object.values(mail.findResources("AWS::S3::BucketPolicy")) as Array<{
      Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
    }>;
    const sesStatements = policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement) => JSON.stringify(statement.Principal ?? {}).includes("ses.amazonaws.com"));
    assert.equal(sesStatements.length, 1);
    const statement = sesStatements[0];
    assert.equal(statement.Effect, "Allow");
    assert.equal(statement.Action, "s3:PutObject");
    const text = JSON.stringify(statement);
    assert.ok(text.includes("/raw/*"));
    assert.ok(text.includes("aws:SourceAccount"));
    assert.ok(text.includes(`receipt-rule-set/${MAIL_RECEIPT_RULE_SET_NAME}:receipt-rule/chatticus-development-mail`));
  });
});

describe("the development mail stack: outbound configuration", () => {
  it("creates one outbound configuration set that is the identity's default", () => {
    mail.resourceCountIs("AWS::SES::ConfigurationSet", 1);
    mail.hasResourceProperties("AWS::SES::ConfigurationSet", { Name: "chatticus-development-outbound" });
    mail.hasResourceProperties("AWS::SES::EmailIdentity", {
      ConfigurationSetAttributes: { ConfigurationSetName: Match.anyValue() },
    });
  });

  it("sends send, bounce, complaint, delivery and reject events to one SNS topic", () => {
    mail.resourceCountIs("AWS::SNS::Topic", 1);
    mail.resourceCountIs("AWS::SES::ConfigurationSetEventDestination", 1);
    mail.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
      EventDestination: Match.objectLike({
        Enabled: true,
        MatchingEventTypes: ["send", "bounce", "complaint", "delivery", "reject"],
        SnsDestination: { TopicARN: Match.anyValue() },
      }),
    });
  });

  it("lets only SES of this account publish to the event topic", () => {
    mail.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Principal: { Service: "ses.amazonaws.com" },
            Action: "sns:Publish",
            Condition: { StringEquals: { "AWS:SourceAccount": Match.anyValue() } },
          }),
        ]),
      },
    });
  });
});

describe("what the mail stacks must never contain", () => {
  const templates: Array<[string, Template]> = [
    ["ingress", ingress],
    ["mail", mail],
  ];

  it("creates no IAM user, access key or login profile", () => {
    for (const [name, template] of templates) {
      for (const type of ["User", "AccessKey", "UserToGroupAddition"].map((kind) => `AWS::IAM::${kind}`)) {
        template.resourceCountIs(type, 0);
      }
      assert.doesNotMatch(JSON.stringify(template.toJSON()), /LoginProfile/, name);
    }
  });

  it("puts no email-looking string in either template", () => {
    for (const [name, template] of templates) {
      assert.doesNotMatch(JSON.stringify(template.toJSON()), /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, name);
    }
  });

  it("touches no SES identity other than its own mail domain, and none of the marketing identity", () => {
    const identities = Object.values(mail.findResources("AWS::SES::EmailIdentity")) as Array<{
      Properties: { EmailIdentity: string };
    }>;
    assert.deepEqual(
      identities.map((identity) => identity.Properties.EmailIdentity),
      [mailDomain],
    );
    ingress.resourceCountIs("AWS::SES::EmailIdentity", 0);
  });
});

describe("the deploy role reads the mail stacks and gets no new permission", () => {
  function allowedStackReads(environment: ChatticusCloudEnvironment): string {
    const app = new cdk.App();
    const stack = new AccountGitHubDeployStack(app, `Deploy${environment}`, { env: ENV, githubEnvironment: environment });
    const statements = Object.values(Template.fromStack(stack).findResources("AWS::IAM::Policy")).flatMap(
      (policy) =>
        (policy as { Properties: { PolicyDocument: { Statement: Array<{ Sid?: string; Effect: string }> } } }).Properties
          .PolicyDocument.Statement,
    );
    return JSON.stringify(statements.filter((statement) => statement.Sid === "ReadEnvironmentStacks"));
  }

  it("lets the development deploy role read the mail stack and the shared ingress stack", () => {
    const text = allowedStackReads("development");
    assert.ok(text.includes(`${MAIL_STACK_IDS.development}/*`));
    assert.ok(text.includes(`${MAIL_INGRESS_STACK_ID}/*`));
  });

  it("does not let the staging or production deploy role read either, since mail is development only", () => {
    for (const environment of ["staging", "production"] as const) {
      const text = allowedStackReads(environment);
      assert.equal(text.includes(MAIL_INGRESS_STACK_ID), false, environment);
      assert.equal(text.includes("ChatticusMail"), false, environment);
    }
  });

  it("adds no SES, Route 53 or S3 action to the deploy role: those calls run under the CDK bootstrap roles", () => {
    const app = new cdk.App();
    const stack = new AccountGitHubDeployStack(app, "DeployDevelopmentPermissions", { env: ENV, githubEnvironment: "development" });
    const text = JSON.stringify(Template.fromStack(stack).toJSON());
    assert.doesNotMatch(text, /"ses:|"route53:|"s3:/);
  });
});
