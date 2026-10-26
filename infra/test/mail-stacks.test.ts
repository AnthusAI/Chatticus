import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AccountGitHubDeployStack } from "../lib/account-github-deploy-stack";
import { buildDedicatedAccountStacks } from "../lib/dedicated-account-stacks";
import {
  CHANNELS_EVENT_SOURCE,
  CONTROL_PLANE_STACK_IDS,
  CHANNELS_MESSAGE_CREATED_DETAIL_TYPE,
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
import { CHANNEL_EVENT_SOURCE } from "../../conversation/src/channels/eventbridge-publisher";
import { CHANNEL_MESSAGE_CREATED } from "../../conversation/src/channels/events";

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

  it("stores raw mail in S3 first and then invokes the ingress function asynchronously, so the archive stays the system of record", () => {
    const [rule] = Object.values(mail.findResources("AWS::SES::ReceiptRule")) as Array<{
      Properties: { Rule: { Actions: Array<Record<string, any>> } };
      DependsOn?: string[];
    }>;
    const actions = rule.Properties.Rule.Actions;
    assert.equal(actions.length, 2);
    assert.ok("S3Action" in actions[0]!, "the S3 action is first");
    assert.equal(actions[0]!.S3Action.ObjectKeyPrefix, "raw/");
    assert.ok("LambdaAction" in actions[1]!, "the Lambda action is second");
    assert.equal(actions[1]!.LambdaAction.InvocationType, "Event");
    assert.match(JSON.stringify(actions[1]!.LambdaAction.FunctionArn), /MailIngress/);
    assert.ok((rule.DependsOn ?? []).some((name) => name.startsWith("LambdasMailIngress")), "the rule is created after the function");
    assert.ok((rule.DependsOn ?? []).some((name) => name.startsWith("SesMayInvokeIngress")), "the rule is created after the permission");
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


describe("the development mail stack: deploy order", () => {
  it("is deployed after the control plane and the shared ingress stack, whose resources it imports, and before nothing", () => {
    const names = stackOf(developmentApp, MAIL_STACK_IDS.development).dependencies.map((stack) => stack.node.id);
    assert.ok(names.includes(MAIL_INGRESS_STACK_ID));
    assert.ok(names.includes(CONTROL_PLANE_STACK_IDS.development));
    for (const stack of developmentApp.node.children.filter(cdk.Stack.isStack)) {
      assert.equal(stack.dependencies.some((dependency) => dependency.node.id === MAIL_STACK_IDS.development), false, `${stack.node.id} must not wait for mail`);
    }
  });
});

describe("the development mail stack: the mail functions", () => {
  type Resource = { Type: string; Properties: Record<string, any>; DependsOn?: string[] };
  const resources = mail.toJSON().Resources as Record<string, Resource>;
  const ofType = (type: string): Array<[string, Resource]> => Object.entries(resources).filter(([, resource]) => resource.Type === type);
  const functionIdOf = (key: string): string => {
    const found = ofType("AWS::Lambda::Function").find(([id]) => id.startsWith(`Lambdas${key}`) && !id.includes("LogRetention"));
    assert.ok(found, `no function ${key}`);
    return found[0];
  };
  const roleIdOf = (key: string): string => {
    const found = ofType("AWS::IAM::Role").find(([id]) => id.startsWith(`Lambdas${key}ServiceRole`));
    assert.ok(found, `no role ${key}`);
    return found[0];
  };
  const statementsOf = (key: string): Array<Record<string, any>> => {
    const roleId = roleIdOf(key);
    return ofType("AWS::IAM::Policy")
      .filter(([, policy]) => (policy.Properties.Roles as Array<{ Ref: string }>).some((role) => role.Ref === roleId))
      .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement as Array<Record<string, any>>);
  };
  const actionsOf = (statement: Record<string, any>): string[] => ([] as string[]).concat(statement.Action);
  const allActions = (key: string): string[] => statementsOf(key).flatMap(actionsOf);

  it("creates exactly the three functions, with no IAM user", () => {
    const names = ofType("AWS::Lambda::Function").map(([id]) => id).filter((id) => id.startsWith("Lambdas") && !id.includes("LogRetention"));
    assert.equal(names.length, 3);
    mail.resourceCountIs("AWS::IAM::User", 0);
  });

  it("lets only SES of this account, for this one receipt rule, invoke the ingress function", () => {
    const permission = ofType("AWS::Lambda::Permission").find(([id]) => id.startsWith("SesMayInvokeIngress"))?.[1];
    assert.ok(permission);
    assert.equal(permission.Properties.Principal, "ses.amazonaws.com");
    assert.ok(permission.Properties.SourceAccount);
    assert.match(JSON.stringify(permission.Properties.SourceArn), /receipt-rule-set\/chatticus-mail-ingress:receipt-rule\/chatticus-development-mail/);
  });

  it("gives the ingress function s3:GetObject on the raw prefix only, the admission stores and the two turn queues, and no SES, events or secret other than the correlator", () => {
    const actions = allActions("MailIngress");
    const raw = statementsOf("MailIngress").filter((statement) => JSON.stringify(statement.Resource).includes("raw/") && actionsOf(statement).includes("s3:GetObject"));
    assert.equal(raw.length, 1);
    assert.deepEqual(raw[0]!.Action, "s3:GetObject");
    assert.equal(actions.some((action) => action.startsWith("ses:") || action.startsWith("events:") || action.startsWith("secretsmanager:")), false);
    const listing = statementsOf("MailIngress").filter((statement) => actionsOf(statement).includes("s3:ListBucket"));
    assert.equal(listing.length, 1);
    assert.deepEqual(listing[0]!.Condition, { "ForAllValues:StringLike": { "s3:prefix": ["raw/*"] } });
    assert.equal(statementsOf("MailDelivery").concat(statementsOf("MailStatus")).some((statement) => JSON.stringify(statement.Resource).includes("RawMailBucket")), false);
    assert.equal(actions.includes("sqs:SendMessage"), true);
    assert.equal(actions.includes("s3:PutObject"), false);
  });

  it("gives the delivery function ses:SendEmail on exactly the domain identity and the configuration set, and no read of the raw mail", () => {
    const send = statementsOf("MailDelivery").filter((statement) => actionsOf(statement).includes("ses:SendEmail"));
    assert.equal(send.length, 1);
    assert.equal(send[0]!.Action, "ses:SendEmail");
    const resources = ([] as unknown[]).concat(send[0]!.Resource).map((resource) => JSON.stringify(resource));
    assert.equal(resources.length, 2);
    assert.ok(resources.some((resource) => resource.includes(`identity/${mailDomain}`)));
    assert.ok(resources.some((resource) => resource.includes("configuration-set/chatticus-development-outbound")));
    assert.equal(JSON.stringify(send[0]).includes("*"), false);
    assert.equal(allActions("MailDelivery").some((action) => action.startsWith("events:") || action === "s3:PutObject"), false);
    assert.equal(statementsOf("MailDelivery").some((statement) => JSON.stringify(statement.Resource).includes("raw/")), false);
  });

  it("gives the status function neither SES, nor the raw mail, nor the turn queues, nor events: it may only send to its own dead-letter queue", () => {
    const actions = allActions("MailStatus");
    assert.equal(actions.some((action) => action.startsWith("ses:") || action.startsWith("events:")), false);
    for (const statement of statementsOf("MailStatus").filter((candidate) => actionsOf(candidate).some((action) => action.startsWith("sqs:")))) {
      assert.match(JSON.stringify(statement.Resource), /MailStatusDeadLetter/);
    }
    assert.equal(statementsOf("MailStatus").some((statement) => JSON.stringify(statement.Resource).includes("raw/")), false);
  });

  it("lets every function read the correlator secret by its exact parameter ARN and nothing broader", () => {
    for (const key of ["MailIngress", "MailDelivery", "MailStatus"]) {
      const readers = statementsOf(key).filter((statement) => actionsOf(statement).includes("ssm:GetParameter"));
      assert.equal(readers.length, 1, key);
      assert.equal(readers[0]!.Action, "ssm:GetParameter");
      assert.match(JSON.stringify(readers[0]!.Resource), /parameter\/chatticus\/development\/channels\/correlator-secret"/);
      assert.equal(JSON.stringify(readers[0]!.Resource).includes("*"), false);
    }
  });

  it("subscribes the status function to the configuration set topic, which signs with signature version 2", () => {
    mail.hasResourceProperties("AWS::SNS::Topic", { SignatureVersion: "2" });
    mail.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "lambda", TopicArn: Match.anyValue() });
    const subscription = ofType("AWS::SNS::Subscription")[0]![1];
    assert.match(JSON.stringify(subscription.Properties.Endpoint), /MailStatus/);
    const permission = ofType("AWS::Lambda::Permission").find(([, candidate]) => candidate.Properties.Principal === "sns.amazonaws.com")?.[1];
    assert.ok(permission, "SNS may invoke the status function");
    assert.match(JSON.stringify(permission.Properties.FunctionName), /MailStatus/);
  });

  it("hands the status function the topic ARN to trust, and the delivery function the configuration set and the web app", () => {
    const variablesOf = (key: string): Record<string, unknown> => resources[functionIdOf(key)]!.Properties.Environment.Variables;
    assert.ok(variablesOf("MailStatus")["CHATTICUS_CHANNELS_MAIL_EVENTS_TOPIC_ARN"]);
    assert.equal(variablesOf("MailDelivery")["CHATTICUS_CHANNELS_CONFIGURATION_SET_NAME"], "chatticus-development-outbound");
    assert.equal(variablesOf("MailDelivery")["CHATTICUS_CHANNELS_WEB_APP_BASE_URL"], "https://develop.chattic.us");
    assert.equal(variablesOf("MailIngress")["CHATTICUS_CHANNELS_KILL_SWITCH"], "released");
    assert.ok(variablesOf("MailIngress")["CHATTICUS_CHANNELS_RAW_MAIL_BUCKET"]);
    assert.equal(JSON.stringify(variablesOf("MailStatus")).includes("correlator-secret\":"), false);
  });

  it("routes channel.message.created from chatticus.channels on the default bus to the delivery function", () => {
    mail.hasResourceProperties("AWS::Events::Rule", {
      EventBusName: "default",
      EventPattern: { source: [CHANNELS_EVENT_SOURCE], "detail-type": [CHANNELS_MESSAGE_CREATED_DETAIL_TYPE] },
      Targets: [Match.objectLike({ Arn: Match.anyValue(), RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 } })],
    });
    const rule = ofType("AWS::Events::Rule")[0]![1];
    assert.match(JSON.stringify(rule.Properties.Targets), /MailDelivery/);
    assert.equal(CHANNELS_EVENT_SOURCE, CHANNEL_EVENT_SOURCE);
    assert.equal(CHANNELS_MESSAGE_CREATED_DETAIL_TYPE, CHANNEL_MESSAGE_CREATED);
  });

  it("runs a failed invocation again twice and then sends it to the function's own dead-letter queue", () => {
    const configs = ofType("AWS::Lambda::EventInvokeConfig");
    assert.equal(configs.length, 3);
    for (const [, config] of configs) {
      assert.equal(config.Properties.MaximumRetryAttempts, 2);
      assert.equal(config.Properties.MaximumEventAgeInSeconds, 3600);
      assert.ok(config.Properties.DestinationConfig.OnFailure.Destination);
    }
    assert.equal(new Set(configs.map(([, config]) => JSON.stringify(config.Properties.DestinationConfig.OnFailure.Destination))).size, 3);
  });

  it("alarms on the errors and on the dead letters of each function, to the environment's alarm topic", () => {
    const alarms = ofType("AWS::CloudWatch::Alarm").map(([, alarm]) => alarm.Properties);
    for (const suffix of ["mailingress", "maildelivery", "mailstatus"]) {
      for (const kind of ["errors", "dead-letter"]) {
        const alarm = alarms.find((candidate) => candidate.AlarmName === `chatticus-development-${suffix}-${kind}`);
        assert.ok(alarm, `${suffix} ${kind}`);
        assert.equal(JSON.stringify(alarm.AlarmActions).includes("Import"), true);
      }
    }
    assert.equal(alarms.length, 6);
  });

  it("encrypts nothing with a customer key and adds no VPC, so the status function can fetch the SNS certificate", () => {
    assert.equal(JSON.stringify(resources[functionIdOf("MailStatus")]!.Properties).includes("VpcConfig"), false);
  });
});
